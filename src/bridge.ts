import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The bridge folder is the mapped host<->guest folder. Resolved from SANDBOX_BRIDGE_ROOT,
 * else relative to this compiled file: dist/ is at the package root, so bridge is ../bridge.
 */
export const bridgeRoot = path.resolve(
  process.env.SANDBOX_BRIDGE_ROOT ?? path.join(here, "..", "bridge"),
);
export const projectRoot = path.resolve(bridgeRoot, "..");
const commandsDir = path.join(bridgeRoot, "commands");
const resultsDir = path.join(bridgeRoot, "results");
const screenshotsDir = path.join(bridgeRoot, "artifacts", "screenshots");

const sandboxBridgePs1 =
  process.env.SANDBOX_BRIDGE_PS1 ?? path.join(projectRoot, "host", "SandboxBridge.ps1");
const annotatePs1 =
  process.env.SANDBOX_ANNOTATE_PS1 ?? path.join(projectRoot, "host", "AnnotateScreenshot.ps1");

export interface BridgeResult {
  id: string;
  type: string;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  data: any;
  artifacts: string[];
  error: string | null;
}

/** Map a guest path (C:\SandboxBridge\artifacts\screenshots\x.jpg) to the host screenshot folder. */
function guestScreenshotToHost(guestPath: string): string {
  return path.join(screenshotsDir, path.win32.basename(guestPath));
}

/** Wait for results/<id>.json to appear, using fs.watch for instant pickup plus a polling fallback. */
function waitForResult(id: string, timeoutMs: number): Promise<BridgeResult> {
  const resultPath = path.join(resultsDir, `${id}.json`);
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher: fs.FSWatcher | undefined;
    let poll: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      if (watcher) watcher.close();
    };
    const tryRead = () => {
      fs.readFile(resultPath, "utf8", (err, data) => {
        if (settled || err) return;
        let parsed: BridgeResult;
        try {
          // Strip a UTF-8 BOM (Windows PowerShell 5.1 Set-Content -Encoding UTF8 writes one).
          const clean = data.charCodeAt(0) === 0xfeff ? data.slice(1) : data;
          parsed = JSON.parse(clean);
        } catch {
          return; // result is mid-write; the atomic rename means this is rare — retry
        }
        settled = true;
        cleanup();
        resolve(parsed);
      });
    };

    try {
      watcher = fs.watch(resultsDir, (_event, filename) => {
        if (!filename || filename.toString() === `${id}.json`) tryRead();
      });
    } catch {
      // results dir may not exist yet; polling will cover it
    }
    poll = setInterval(tryRead, 200);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timed out waiting for sandbox result ${id} after ${timeoutMs}ms`));
    }, timeoutMs);

    tryRead(); // in case the result already exists
  });
}

/** Send one command to the guest agent and await its result. */
export async function sendCommand(
  type: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30000,
): Promise<BridgeResult> {
  await fsp.mkdir(commandsDir, { recursive: true });
  await fsp.mkdir(resultsDir, { recursive: true });

  const id = randomUUID();
  const payload = { id, type, createdAt: new Date().toISOString(), args };
  const tmp = path.join(commandsDir, `${id}.tmp`);
  const final = path.join(commandsDir, `${id}.json`);

  // Write then atomically rename so the guest never reads a partial command.
  await fsp.writeFile(tmp, JSON.stringify(payload), "utf8");
  await fsp.rename(tmp, final);

  const result = await waitForResult(id, timeoutMs);
  if (!result.ok) throw new Error(result.error ?? `Command '${type}' failed`);
  return result;
}

export interface Screenshot {
  base64: string;
  mimeType: string;
  hostPath: string;
  metadataPath: string;
  meta: any;
}

/** Take a downscaled JPEG screenshot and return it inline plus its host path + metadata. */
export interface ScreenshotOpts {
  maxWidth?: number;
  quality?: number;
  timeoutMs?: number;
  region?: number[];
  window?: boolean;
}

export async function screenshot(opts: ScreenshotOpts = {}): Promise<Screenshot> {
  const result = await sendCommand(
    "screenshot",
    { maxWidth: opts.maxWidth ?? 1280, quality: opts.quality ?? 70, region: opts.region, window: opts.window ?? false },
    opts.timeoutMs ?? 60000,
  );
  const hostPath = guestScreenshotToHost(result.data.path);
  const metadataPath = hostPath.replace(/\.jpg$/i, ".json");
  const buf = await fsp.readFile(hostPath);
  return {
    base64: buf.toString("base64"),
    mimeType: "image/jpeg",
    hostPath,
    metadataPath,
    meta: result.data,
  };
}

/** Run a host-side SandboxBridge.ps1 action (lifecycle) and parse its JSON output. */
export function runBridgeAction(action: string, extraArgs: string[] = []): Promise<any> {
  return runPowerShellFile(sandboxBridgePs1, [action, ...extraArgs]);
}

/** Annotate a screenshot via the host-side AnnotateScreenshot.ps1; returns the annotated image inline. */
export async function annotate(opts: {
  inputPath: string;
  outputPath?: string;
  shapes: unknown[];
  mode?: "screen" | "image";
  metadataPath?: string;
  quality?: number;
}): Promise<Screenshot> {
  const mode = opts.mode ?? "image";
  const outputPath =
    opts.outputPath ?? opts.inputPath.replace(/\.jpg$/i, "-annotated.jpg");

  // Pass shapes via a temp file to avoid any CLI JSON-quoting issues.
  const shapesPath = path.join(os.tmpdir(), `sandbox-shapes-${randomUUID()}.json`);
  await fsp.writeFile(shapesPath, JSON.stringify(opts.shapes), "utf8");

  const args = [
    "-InputPath", opts.inputPath,
    "-OutputPath", outputPath,
    "-Mode", mode,
    "-ShapesPath", shapesPath,
    "-Quality", String(opts.quality ?? 85),
  ];
  if (mode === "screen") {
    const metaPath = opts.metadataPath ?? opts.inputPath.replace(/\.jpg$/i, ".json");
    args.push("-MetadataPath", metaPath);
  }

  try {
    await runPowerShellFile(annotatePs1, args);
  } finally {
    await fsp.rm(shapesPath, { force: true });
  }

  const buf = await fsp.readFile(outputPath);
  return {
    base64: buf.toString("base64"),
    mimeType: "image/jpeg",
    hostPath: outputPath,
    metadataPath: opts.metadataPath ?? "",
    meta: { annotated: true, mode },
  };
}

/** Run a PowerShell script file, capture stdout, and JSON.parse it if possible. */
function runPowerShellFile(scriptPath: string, scriptArgs: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...scriptArgs],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${path.basename(scriptPath)} exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const text = stdout.trim();
      try {
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve({ raw: text });
      }
    });
  });
}
