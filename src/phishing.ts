import * as fsp from "node:fs/promises";
import * as path from "node:path";

export type ForegroundMode = "none" | "first" | "highestRisk" | "all";

export interface PhishingInput {
  url?: string;
  emailText?: string;
  emailHostPath?: string;
  emailGuestPath?: string;
  maxUrls?: number;
  foregroundMode?: ForegroundMode;
  waitMs?: number;
  captureScreenshot?: boolean;
  timeoutMs?: number;
}

export interface PhishingDeps {
  sendCommand: (type: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<{ data: any }>;
  screenshot: (opts: { window?: boolean; region?: number[]; maxWidth?: number; quality?: number }) => Promise<{ base64: string; hostPath: string; meta?: any }>;
  bridgeRoot: string;
}

interface UrlTarget {
  id: string;
  url: string;
  raw: string;
  source: "input" | "emailText" | "htmlAnchor";
  anchorText?: string;
}

interface Finding {
  severity: "info" | "low" | "medium" | "high";
  points: number;
  message: string;
}

interface Analysis {
  id: string;
  url: string;
  source: string;
  anchorText?: string;
  score: number;
  risk: "low" | "medium" | "high";
  findings: Finding[];
  background?: any;
  foreground?: any;
}

const SHORTENER_HOSTS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "cutt.ly",
  "rebrand.ly",
  "rb.gy",
  "s.id",
  "shorturl.at",
  "tiny.cc",
  "lnkd.in",
]);

const RISK_WORDS = [
  "account",
  "bank",
  "billing",
  "confirm",
  "credential",
  "invoice",
  "login",
  "mfa",
  "office",
  "password",
  "payment",
  "paypal",
  "secure",
  "signin",
  "sso",
  "update",
  "verify",
  "wallet",
];

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "phishing-url-test";
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value: string): string {
  return htmlDecode(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function trimUrlTail(value: string): string {
  let out = value.trim();
  while (/[)\].,;!?'"<>]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function normalizeUrl(raw: string): string | null {
  let value = htmlDecode(trimUrlTail(raw));
  value = value.replace(/^hxxps?:\/\//i, (m) => m.toLowerCase().startsWith("hxxps") ? "https://" : "http://");
  value = value.replace(/\[\.\]/g, ".").replace(/\(dot\)/gi, ".");
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

export function extractUrlTargets(input: { url?: string; emailText?: string }, maxUrls = 10): UrlTarget[] {
  const targets: UrlTarget[] = [];
  const seen = new Set<string>();

  const add = (raw: string, source: UrlTarget["source"], anchorText?: string) => {
    const normalized = normalizeUrl(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    targets.push({
      id: `url-${targets.length + 1}`,
      url: normalized,
      raw,
      source,
      anchorText: anchorText ? stripHtml(anchorText) : undefined,
    });
  };

  if (input.url) add(input.url, "input");

  const text = input.emailText ?? "";
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*(["']?)([^"'\s>]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of text.matchAll(anchorRe)) add(match[2], "htmlAnchor", match[3]);

  const urlRe = /\b(?:https?|hxxps?):\/\/[^\s<>"']+/gi;
  for (const match of text.matchAll(urlRe)) add(match[0], "emailText");

  return targets.slice(0, Math.max(1, maxUrls));
}

function addFinding(findings: Finding[], severity: Finding["severity"], points: number, message: string): void {
  findings.push({ severity, points, message });
}

function riskFromScore(score: number): Analysis["risk"] {
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function hostnameFromTextUrl(value: string): string | null {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function scoreUrlTarget(target: UrlTarget): Analysis {
  const findings: Finding[] = [];
  let parsed: URL | null = null;

  try {
    parsed = new URL(target.url);
  } catch {
    addFinding(findings, "high", 40, "URL could not be parsed cleanly.");
  }

  if (target.raw.toLowerCase().startsWith("hxxp") || target.raw.includes("[.]")) {
    addFinding(findings, "low", 8, "URL appears defanged in the email, which is common in security reporting but unusual in normal mail.");
  }

  if (target.anchorText) {
    const displayedHost = hostnameFromTextUrl(target.anchorText);
    if (displayedHost && parsed && displayedHost !== parsed.hostname.toLowerCase()) {
      addFinding(findings, "high", 55, `Link text shows ${displayedHost}, but the href goes to ${parsed.hostname}.`);
    }
    if (/\b(verify|password|account|payment|invoice|sign\s*in|login|urgent)\b/i.test(target.anchorText)) {
      addFinding(findings, "low", 8, "Link text uses credential, payment, or urgency language.");
    }
  }

  if (parsed) {
    const host = parsed.hostname.toLowerCase();
    const hostParts = host.split(".").filter(Boolean);
    const text = `${host} ${parsed.pathname} ${parsed.search}`.toLowerCase();

    if (parsed.username || parsed.password) addFinding(findings, "high", 30, "URL contains userinfo before the host, which can obscure the real destination.");
    if (parsed.protocol !== "https:") addFinding(findings, "medium", 15, "URL does not use HTTPS.");
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^\[[0-9a-f:]+\]$/i.test(host)) {
      addFinding(findings, "high", 25, "URL uses a raw IP address instead of a domain name.");
    }
    if (host.includes("xn--")) addFinding(findings, "high", 25, "Hostname uses punycode, which can hide lookalike characters.");
    if (SHORTENER_HOSTS.has(host)) addFinding(findings, "medium", 20, "URL uses a public link shortener, hiding the final destination.");
    if (hostParts.length >= 5) addFinding(findings, "medium", 12, "Hostname has many subdomains, which can be used to bury the registered domain.");
    if (host.length > 60) addFinding(findings, "low", 8, "Hostname is unusually long.");
    if (target.url.length > 180) addFinding(findings, "low", 8, "URL is unusually long.");
    if ((target.url.match(/%[0-9a-f]{2}/gi) ?? []).length >= 6) addFinding(findings, "low", 8, "URL contains heavy percent-encoding.");
    if ((parsed.search.match(/[?&][^=]+=/g) ?? []).length >= 8) addFinding(findings, "low", 8, "URL contains many query parameters.");
    if (parsed.port && !["80", "443"].includes(parsed.port)) addFinding(findings, "medium", 12, `URL uses non-standard port ${parsed.port}.`);
    if (/\.(exe|scr|js|jse|vbs|vbe|wsf|ps1|msi|iso|img|zip|rar|7z)$/i.test(parsed.pathname)) {
      addFinding(findings, "high", 25, "URL path appears to point directly at an executable or archive payload.");
    }
    const matchedWords = RISK_WORDS.filter((word) => text.includes(word));
    if (matchedWords.length) addFinding(findings, "low", Math.min(18, matchedWords.length * 4), `URL contains phishing-themed terms: ${matchedWords.slice(0, 6).join(", ")}.`);
  }

  const score = findings.reduce((sum, item) => sum + item.points, 0);
  return {
    id: target.id,
    url: target.url,
    source: target.source,
    anchorText: target.anchorText,
    score,
    risk: riskFromScore(score),
    findings,
  };
}

function psSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function backgroundCheckScript(url: string): string {
  return `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
$url = ${psSingle(url)}
$result = [ordered]@{ url = $url; host = $null; dns = @(); tls = $null; redirects = @(); finalUrl = $url; errors = @() }
try {
  $uri = [Uri]$url
  $result.host = $uri.Host
  try {
    $result.dns = @(Resolve-DnsName -Name $uri.Host -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object Type, Name, IPAddress)
  } catch {
    $result.errors += "DNS lookup failed: $($_.Exception.Message)"
  }
  if ($uri.Scheme -eq "https") {
    $tcp = $null
    $ssl = $null
    try {
      $tcp = [System.Net.Sockets.TcpClient]::new()
      $async = $tcp.BeginConnect($uri.Host, 443, $null, $null)
      if (-not $async.AsyncWaitHandle.WaitOne(5000)) { throw "TCP connect to 443 timed out" }
      $tcp.EndConnect($async)
      $ssl = [System.Net.Security.SslStream]::new($tcp.GetStream(), $false, ({ $true }))
      $ssl.AuthenticateAsClient($uri.Host)
      $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($ssl.RemoteCertificate)
      $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
      $chainOk = $chain.Build($cert)
      $result.tls = [ordered]@{
        subject = $cert.Subject
        issuer = $cert.Issuer
        notBefore = $cert.NotBefore.ToString("o")
        notAfter = $cert.NotAfter.ToString("o")
        chainOk = $chainOk
        chainErrors = @($chain.ChainStatus | ForEach-Object { $_.StatusInformation.Trim() } | Where-Object { $_ })
      }
    } catch {
      $result.errors += "TLS check failed: $($_.Exception.Message)"
    } finally {
      if ($ssl) { $ssl.Dispose() }
      if ($tcp) { $tcp.Dispose() }
    }
  }
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(12)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd("SandboxPilotPhishingCheck/1.0")
  $current = $uri
  for ($i = 0; $i -lt 6; $i++) {
    try {
      $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head, $current)
      $resp = $client.SendAsync($req).GetAwaiter().GetResult()
      $location = if ($resp.Headers.Location) { $resp.Headers.Location.ToString() } else { $null }
      $contentType = if ($resp.Content.Headers.ContentType) { $resp.Content.Headers.ContentType.ToString() } else { $null }
      $result.redirects += [ordered]@{
        url = $current.ToString()
        status = [int]$resp.StatusCode
        reason = $resp.ReasonPhrase
        location = $location
        contentType = $contentType
        server = ($resp.Headers.Server | ForEach-Object { $_.ToString() }) -join " "
      }
      if (-not $location -or [int]$resp.StatusCode -lt 300 -or [int]$resp.StatusCode -ge 400) { break }
      $current = [Uri]::new($current, $location)
      $result.finalUrl = $current.ToString()
    } catch {
      $result.errors += "HTTP check failed for $($current.ToString()): $($_.Exception.Message)"
      break
    }
  }
} catch {
  $result.errors += "URL setup failed: $($_.Exception.Message)"
}
$result | ConvertTo-Json -Depth 8
`;
}

function parseJsonOutput(data: any): any {
  const output = String(data?.stdout ?? data?.output ?? "").trim();
  if (!output) return { errors: ["No PowerShell output returned."], raw: data };
  try {
    return JSON.parse(output);
  } catch {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(output.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    return { errors: ["Could not parse PowerShell JSON output."], rawOutput: output };
  }
}

function applyLiveFindings(analysis: Analysis): void {
  const bg = analysis.background;
  if (!bg) return;
  const findings = analysis.findings;
  if (Array.isArray(bg.errors) && bg.errors.length) {
    addFinding(findings, "low", Math.min(15, bg.errors.length * 5), `Background checks reported errors: ${bg.errors.slice(0, 2).join("; ")}.`);
  }
  if (Array.isArray(bg.dns) && bg.dns.length === 0) addFinding(findings, "low", 5, "DNS lookup returned no address records from inside the Sandbox.");
  if (bg.tls && bg.tls.chainOk === false) addFinding(findings, "high", 25, "TLS certificate chain did not validate cleanly in the Sandbox.");
  if (bg.tls?.notAfter && Date.parse(bg.tls.notAfter) < Date.now()) addFinding(findings, "high", 25, "TLS certificate is expired.");
  const redirects = Array.isArray(bg.redirects) ? bg.redirects : [];
  if (redirects.length > 3) addFinding(findings, "low", 8, `URL follows a long redirect chain (${redirects.length} hops checked).`);
  if (bg.finalUrl && bg.finalUrl !== analysis.url) {
    try {
      const initial = new URL(analysis.url).hostname.toLowerCase();
      const final = new URL(bg.finalUrl).hostname.toLowerCase();
      if (initial !== final) addFinding(findings, "medium", 15, `Redirects from ${initial} to ${final}.`);
      if (new URL(bg.finalUrl).protocol !== "https:") addFinding(findings, "medium", 15, "Final redirect destination is not HTTPS.");
    } catch {
      // ignore malformed final URL
    }
  }
  const last = redirects[redirects.length - 1];
  if (last?.contentType && /(application\/octet-stream|application\/x-msdownload|zip|compressed)/i.test(last.contentType)) {
    addFinding(findings, "high", 20, `Final content type looks like a download: ${last.contentType}.`);
  }
  analysis.score = findings.reduce((sum, item) => sum + item.points, 0);
  analysis.risk = riskFromScore(analysis.score);
}

async function runBackgroundCheck(deps: PhishingDeps, url: string, timeoutMs: number): Promise<any> {
  const data = (await deps.sendCommand("run_ps", { command: backgroundCheckScript(url), timeoutMs }, timeoutMs + 5000)).data;
  return parseJsonOutput(data);
}

async function openInEdge(deps: PhishingDeps, url: string, runDir: string, index: number, waitMs: number, captureScreenshot: boolean): Promise<any> {
  const command = `
$edgeCandidates = @("$env:ProgramFiles(x86)\\Microsoft\\Edge\\Application\\msedge.exe", "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe")
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { $edge = "msedge.exe" }
Start-Process -FilePath $edge -ArgumentList @("--new-window", "--inprivate", ${psSingle(url)})
Start-Sleep -Milliseconds ${Math.max(1000, waitMs)}
[ordered]@{ opened = ${psSingle(url)}; edge = $edge } | ConvertTo-Json -Depth 4
`;
  const opened = parseJsonOutput((await deps.sendCommand("run_ps", { command, timeoutMs: waitMs + 15000 }, waitMs + 20000)).data);
  const uiTree = (await deps.sendCommand("ui_tree", { scope: "window", onlyInteractive: false, maxDepth: 5, maxNodes: 220 }, 30000)).data;
  const result: any = { opened, uiTreeSummary: summarizeUiTree(uiTree) };

  if (captureScreenshot) {
    const shot = await deps.screenshot({ window: true, maxWidth: 1280, quality: 75 });
    const file = `foreground-${String(index).padStart(2, "0")}.jpg`;
    const target = path.join(runDir, file);
    await fsp.copyFile(shot.hostPath, target);
    result.screenshot = target;
  }

  const uiText = JSON.stringify(uiTree).toLowerCase();
  const warnings = ["phishing", "deceptive", "unsafe", "smartscreen", "malware", "blocked", "password", "sign in", "login"]
    .filter((word) => uiText.includes(word));
  if (warnings.length) result.visibleSignals = warnings;
  return result;
}

function summarizeUiTree(uiTree: any): any {
  const text = JSON.stringify(uiTree);
  return {
    truncated: !!uiTree?.truncated,
    nodeCount: Array.isArray(uiTree?.nodes) ? uiTree.nodes.length : undefined,
    textSample: text.replace(/\s+/g, " ").slice(0, 1200),
  };
}

function chooseForegroundIndexes(analyses: Analysis[], mode: ForegroundMode): number[] {
  if (mode === "none" || analyses.length === 0) return [];
  if (mode === "all") return analyses.map((_a, index) => index);
  if (mode === "first") return [0];
  let best = 0;
  for (let i = 1; i < analyses.length; i++) {
    if (analyses[i].score > analyses[best].score) best = i;
  }
  return [best];
}

function buildMarkdown(summary: any, analyses: Analysis[]): string {
  let md = `# Phishing URL test: ${summary.name}\n\n`;
  md += `**Verdict:** ${summary.verdict.toUpperCase()} (${summary.highestRisk} risk, max score ${summary.maxScore})\n\n`;
  md += `| URL | Risk | Score | Top reasons |\n|---|---:|---:|---|\n`;
  for (const item of analyses) {
    const reasons = item.findings
      .filter((finding) => finding.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, 4)
      .map((finding) => finding.message.replace(/\|/g, "\\|"))
      .join("<br>");
    md += `| ${item.url} | ${item.risk} | ${item.score} | ${reasons || "No strong phishing indicators detected."} |\n`;
  }
  md += `\n`;
  for (const item of analyses) {
    md += `## ${item.id}: ${item.risk} (${item.score})\n\n`;
    md += `URL: \`${item.url}\`\n\n`;
    if (item.anchorText) md += `Email link text: ${item.anchorText}\n\n`;
    for (const finding of item.findings.sort((a, b) => b.points - a.points)) {
      md += `- [${finding.severity}] ${finding.message}\n`;
    }
    const redirects = item.background?.redirects ?? [];
    if (redirects.length) {
      md += `\nRedirect/background trace:\n`;
      for (const hop of redirects) {
        md += `- ${hop.status ?? "?"} ${hop.url}${hop.location ? ` -> ${hop.location}` : ""}\n`;
      }
    }
    if (item.foreground?.screenshot) {
      md += `\nForeground Edge screenshot:\n\n![${item.id}](${path.basename(item.foreground.screenshot)})\n`;
    }
    md += `\n`;
  }
  return md;
}

export async function runEmailUrlPhishingTest(deps: PhishingDeps, opts: PhishingInput, stampIso: string): Promise<any> {
  const sources: string[] = [];
  let emailText = opts.emailText ?? "";
  if (opts.emailHostPath) {
    emailText += `\n${await fsp.readFile(opts.emailHostPath, "utf8")}`;
    sources.push(opts.emailHostPath);
  }
  if (opts.emailGuestPath) {
    const command = `Get-Content -LiteralPath ${psSingle(opts.emailGuestPath)} -Raw`;
    const data = (await deps.sendCommand("run_ps", { command, timeoutMs: opts.timeoutMs ?? 30000 }, (opts.timeoutMs ?? 30000) + 5000)).data;
    emailText += `\n${String(data?.stdout ?? data?.output ?? "")}`;
    sources.push(opts.emailGuestPath);
  }

  if (opts.url) sources.push("direct-url");
  if (!opts.url && !emailText.trim()) throw new Error("Provide either url, emailText, emailHostPath, or emailGuestPath.");

  const maxUrls = opts.maxUrls ?? 10;
  const targets = extractUrlTargets({ url: opts.url, emailText }, maxUrls);
  if (!targets.length) throw new Error("No http/https URLs were found in the supplied input.");

  const runId = `${sanitize("phishing-url-test")}-${stampIso.replace(/[:.]/g, "-")}`;
  const runDir = path.join(deps.bridgeRoot, "artifacts", "phishing-url-tests", runId);
  await fsp.mkdir(runDir, { recursive: true });

  const analyses = targets.map(scoreUrlTarget);
  for (const analysis of analyses) {
    analysis.background = await runBackgroundCheck(deps, analysis.url, opts.timeoutMs ?? 30000);
    applyLiveFindings(analysis);
  }

  const foregroundIndexes = chooseForegroundIndexes(analyses, opts.foregroundMode ?? "highestRisk");
  let openCounter = 1;
  for (const index of foregroundIndexes) {
    const analysis = analyses[index];
    analysis.foreground = await openInEdge(
      deps,
      analysis.url,
      runDir,
      openCounter++,
      opts.waitMs ?? 8000,
      opts.captureScreenshot ?? true,
    );
    const foregroundSignals = analysis.foreground.visibleSignals ?? [];
    const blockingSignals = foregroundSignals.filter((signal: string) =>
      ["unsafe", "blocked", "smartscreen", "phishing", "malware", "deceptive"].includes(signal),
    );
    const credentialSignals = foregroundSignals.filter((signal: string) =>
      ["password", "sign in", "login"].includes(signal),
    );
    if (blockingSignals.length) {
      addFinding(analysis.findings, "high", 60, `Foreground browser reported a blocked or unsafe site: ${blockingSignals.join(", ")}.`);
    }
    if (credentialSignals.length) {
      addFinding(analysis.findings, "medium", 12, `Foreground browser text included credential terms: ${credentialSignals.join(", ")}.`);
    }
    if (foregroundSignals.length && !blockingSignals.length && !credentialSignals.length) {
      addFinding(analysis.findings, "medium", 12, `Foreground browser text included warning terms: ${foregroundSignals.join(", ")}.`);
      analysis.score = analysis.findings.reduce((sum, item) => sum + item.points, 0);
      analysis.risk = riskFromScore(analysis.score);
    }
    if (blockingSignals.length || credentialSignals.length) {
      analysis.score = analysis.findings.reduce((sum, item) => sum + item.points, 0);
      analysis.risk = riskFromScore(analysis.score);
    }
  }

  analyses.sort((a, b) => b.score - a.score);
  const maxScore = analyses[0]?.score ?? 0;
  const highestRisk = analyses[0]?.risk ?? "low";
  const summary = {
    runId,
    name: "Email/url phishing analysis",
    verdict: highestRisk === "high" ? "likely-phishing" : highestRisk === "medium" ? "suspicious" : "no-clear-phishing-indicators",
    highestRisk,
    maxScore,
    urlCount: analyses.length,
    sources,
    foregroundMode: opts.foregroundMode ?? "highestRisk",
  };

  const resultsPath = path.join(runDir, "results.json");
  const reportPath = path.join(runDir, "report.md");
  await fsp.writeFile(resultsPath, JSON.stringify({ ...summary, urls: analyses }, null, 2), "utf8");
  await fsp.writeFile(reportPath, buildMarkdown(summary, analyses), "utf8");

  return {
    ...summary,
    artifacts: { dir: runDir, results: resultsPath, report: reportPath },
    urls: analyses.map((analysis) => ({
      id: analysis.id,
      url: analysis.url,
      risk: analysis.risk,
      score: analysis.score,
      topFindings: analysis.findings
        .filter((finding) => finding.points > 0)
        .sort((a, b) => b.points - a.points)
        .slice(0, 5)
        .map((finding) => finding.message),
      foregroundScreenshot: analysis.foreground?.screenshot,
      finalUrl: analysis.background?.finalUrl,
    })),
  };
}
