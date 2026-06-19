import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface DossierInput {
  bridgeRoot: string;
  appName?: string;
  sourceHostFolder?: string;
  setupFile?: string;
  installCommand?: string;
  uninstallCommand?: string;
  detectionRule?: unknown;
  deployment?: any;
  packaging?: any;
  footprint?: any;
  residue?: any;
  notes?: string[];
  stampIso?: string;
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "package";
}

async function hashFile(file: string): Promise<string | null> {
  try {
    const h = crypto.createHash("sha256");
    h.update(await fsp.readFile(file));
    return h.digest("hex");
  } catch {
    return null;
  }
}

async function collectSourceManifest(sourceHostFolder?: string): Promise<any> {
  if (!sourceHostFolder) return null;
  const root = path.resolve(sourceHostFolder);
  const entries: any[] = [];
  async function walk(dir: string) {
    const children = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        await walk(full);
      } else if (child.isFile()) {
        const stat = await fsp.stat(full);
        entries.push({
          path: path.relative(root, full),
          size: stat.size,
          sha256: await hashFile(full),
        });
      }
      if (entries.length >= 250) return;
    }
  }
  await walk(root);
  return {
    root,
    fileCount: entries.length,
    truncated: entries.length >= 250,
    files: entries,
  };
}

function deploymentVerdict(deployment: any): string {
  if (!deployment) return "not run";
  if (deployment.verdict) return deployment.verdict;
  return deployment.passed ? "passed" : "failed";
}

function commandSummary(result: any): string {
  if (!result) return "not run";
  if (result.skipped) return `skipped: ${result.reason ?? "no reason supplied"}`;
  const r = result.result ?? result;
  return `exit ${r.exitCode ?? "n/a"}${r.timedOut ? " (timed out)" : ""}`;
}

function renderRule(rule: unknown): string {
  if (!rule) return "not provided";
  return "```json\n" + JSON.stringify(rule, null, 2) + "\n```";
}

function renderDossierMarkdown(data: any): string {
  const deployment = data.deployment;
  const lines: string[] = [];
  lines.push(`# Intune packaging dossier: ${data.appName}`);
  lines.push("");
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`- IME simulation: **${deploymentVerdict(deployment)}**`);
  if (deployment?.failures?.length) {
    for (const failure of deployment.failures) lines.push(`- Failure: ${failure}`);
  }
  if (deployment?.warnings?.length) {
    for (const warning of deployment.warnings) lines.push(`- Warning: ${warning}`);
  }
  lines.push("");
  lines.push("## Intune Commands");
  lines.push("");
  lines.push(`- Install: \`${data.installCommand || deployment?.install?.result?.command || "not provided"}\``);
  lines.push(`- Uninstall: \`${data.uninstallCommand || deployment?.uninstall?.result?.command || "not provided"}\``);
  lines.push(`- Context: \`${deployment?.context?.installContext ?? "not recorded"}\``);
  lines.push(`- Architecture: \`${deployment?.context?.architecture ?? "not recorded"}\``);
  lines.push("");
  lines.push("## Detection Rule");
  lines.push("");
  lines.push(renderRule(data.detectionRule));
  lines.push("");
  lines.push("## Test Evidence");
  lines.push("");
  lines.push(`- Install result: ${commandSummary(deployment?.install)}`);
  lines.push(`- Detection after install: ${deployment?.detectionAfterInstall?.passed ?? "not run"}`);
  lines.push(`- Uninstall result: ${commandSummary(deployment?.uninstall)}`);
  lines.push(`- Detection after uninstall: ${deployment?.detectionAfterUninstall?.passed ?? "not run"}`);
  if (deployment?.paths?.root) lines.push(`- IME run artifacts: \`${deployment.paths.root}\``);
  lines.push("");
  if (data.footprint?.counts) {
    lines.push("## Install Footprint");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(data.footprint.counts, null, 2));
    lines.push("```");
    if (data.footprint.artifacts?.summary) lines.push(`Full diff: \`${data.footprint.artifacts.summary}\``);
    lines.push("");
  }
  if (data.residue?.counts) {
    lines.push("## Uninstall Residue");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(data.residue.counts, null, 2));
    lines.push("```");
    if (data.residue.artifacts?.summary) lines.push(`Full residue diff: \`${data.residue.artifacts.summary}\``);
    lines.push("");
  }
  if (data.packaging) {
    lines.push("## Package");
    lines.push("");
    lines.push(`- Package creation: ${data.packaging.succeeded ? "succeeded" : "not successful"}`);
    for (const pkg of data.packaging.packages ?? []) {
      lines.push(`- \`${pkg.hostPath ?? pkg.path ?? pkg.name}\`${pkg.sha256 ? ` sha256=${pkg.sha256}` : ""}`);
    }
    lines.push("");
  }
  if (data.sourceManifest) {
    lines.push("## Source Manifest");
    lines.push("");
    lines.push(`- Source root: \`${data.sourceManifest.root}\``);
    lines.push(`- Files listed: ${data.sourceManifest.fileCount}${data.sourceManifest.truncated ? " (truncated)" : ""}`);
    for (const file of data.sourceManifest.files.slice(0, 25)) {
      lines.push(`- \`${file.path}\` (${file.size} bytes) ${file.sha256 ?? ""}`.trim());
    }
    if (data.sourceManifest.files.length > 25) lines.push(`- ...and ${data.sourceManifest.files.length - 25} more files in dossier.json`);
    lines.push("");
  }
  if (data.notes?.length) {
    lines.push("## Notes");
    lines.push("");
    for (const note of data.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function buildPackagingDossier(input: DossierInput): Promise<any> {
  const stamp = input.stampIso ?? new Date().toISOString();
  const appName = input.appName || input.deployment?.appName || input.setupFile || "Intune package";
  const dir = path.join(input.bridgeRoot, "artifacts", "dossiers", `${sanitize(appName)}-${stamp.replace(/[:.]/g, "-")}`);
  await fsp.mkdir(dir, { recursive: true });

  const packaging = input.packaging ? { ...input.packaging } : null;
  if (Array.isArray(packaging?.packages)) {
    packaging.packages = await Promise.all(
      packaging.packages.map(async (pkg: any) => ({
        ...pkg,
        sha256: pkg.hostPath ? await hashFile(pkg.hostPath) : null,
      })),
    );
  }

  const data = {
    appName,
    generatedAt: stamp,
    setupFile: input.setupFile ?? null,
    sourceHostFolder: input.sourceHostFolder ?? null,
    sourceManifest: await collectSourceManifest(input.sourceHostFolder),
    installCommand: input.installCommand ?? null,
    uninstallCommand: input.uninstallCommand ?? null,
    detectionRule: input.detectionRule ?? input.deployment?.detectionRule ?? null,
    deployment: input.deployment ?? null,
    packaging,
    footprint: input.footprint ?? null,
    residue: input.residue ?? null,
    notes: input.notes ?? [],
  };

  const jsonPath = path.join(dir, "dossier.json");
  const mdPath = path.join(dir, "dossier.md");
  await fsp.writeFile(jsonPath, JSON.stringify(data, null, 2), "utf8");
  await fsp.writeFile(mdPath, renderDossierMarkdown(data), "utf8");

  return {
    appName,
    artifacts: {
      dir,
      json: jsonPath,
      markdown: mdPath,
    },
  };
}
