#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { annotate, bridgeInfo, runBridgeAction, stageHostPath, toBridgeHostPath, bridgeRoot } from "./bridge.js";
import * as fileBridge from "./bridge.js";
import * as socketBridge from "./socket-bridge.js";
import { runTestPlan } from "./testplan.js";
import { diffSnapshots } from "./snapshot.js";

// Transport: "socket" (low latency, guest listens / host connects out) or the default
// file bridge (shared folder; simpler but ~20s host->guest propagation).
const TRANSPORT = process.env.SANDBOX_TRANSPORT === "socket" ? socketBridge : fileBridge;
const sendCommand = TRANSPORT.sendCommand;
const screenshot = TRANSPORT.screenshot;

const server = new McpServer({
  name: "sandbox-pilot",
  version: "0.1.0",
});

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

function bridgeHostPath(relativePath?: string | null): string | null {
  return toBridgeHostPath(relativePath);
}

function addBridgeHostPaths(data: any): any {
  if (!data || typeof data !== "object") return data;
  if (data.tool?.bridgeRelativePath) {
    data.tool.hostPath = bridgeHostPath(data.tool.bridgeRelativePath);
  }
  if (Array.isArray(data.packages)) {
    data.packages = data.packages.map((pkg: any) => ({
      ...pkg,
      hostPath: bridgeHostPath(pkg.bridgeRelativePath),
    }));
  }
  if (data.paths?.bridgeRelativePath) {
    data.paths.hostPath = bridgeHostPath(data.paths.bridgeRelativePath);
  }
  return data;
}

function looksLikeHostWindowsPath(value?: string | null): boolean {
  return !!value && /^[a-zA-Z]:[\\/]/.test(value) && !/^C:[\\/]SandboxBridge(?:[\\/]|$)/i.test(value);
}

async function assertNoHostOnlyGuestPath(value: string | undefined, fieldName: string): Promise<void> {
  if (!looksLikeHostWindowsPath(value)) return;
  try {
    await fsp.stat(value!);
  } catch {
    return;
  }
  throw new Error(
    `${fieldName} points to a host path that the Windows Sandbox cannot see: ${value}. ` +
      "Use sandbox_stage_host_path first, or use sandbox_intune_package_from_host for Intune packaging.",
  );
}

async function copyPackagesToHostFolder(packages: any[], outputHostFolder: string): Promise<any[]> {
  await fsp.mkdir(outputHostFolder, { recursive: true });
  const copied = [];
  for (const pkg of packages) {
    if (!pkg.hostPath) continue;
    const destination = path.join(outputHostFolder, path.basename(pkg.hostPath));
    await fsp.copyFile(pkg.hostPath, destination);
    copied.push({ ...pkg, hostPath: destination });
  }
  return copied;
}

// ---- Sensing -------------------------------------------------------------

server.registerTool(
  "sandbox_screenshot",
  {
    title: "Screenshot the Sandbox",
    description:
      "Capture the Windows Sandbox desktop as a downscaled JPEG, returned inline. " +
      "Use for visual judgment (rendering, images, 'does this look right'). For locating " +
      "click targets, prefer sandbox_ui_tree, which is cheaper and gives exact coordinates. " +
      "The text block reports the image's scale and original screen size.",
    inputSchema: {
      maxWidth: z.number().int().positive().optional().describe("Max width in px before downscale (default 1280)."),
      quality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100 (default 70)."),
      window: z.boolean().optional().describe("Capture only the foreground window (sharper, cheaper) instead of the full screen."),
      region: z.array(z.number()).length(4).optional().describe("[x,y,w,h] real-screen crop to capture; overridden by window."),
    },
  },
  async ({ maxWidth, quality, window, region }) => {
    const shot = await screenshot({ maxWidth, quality, window, region });
    const { imageBase64, ...metaNoImage } = shot.meta ?? {};
    return {
      content: [
        { type: "image", data: shot.base64, mimeType: shot.mimeType },
        { type: "text", text: JSON.stringify({ hostPath: shot.hostPath, ...metaNoImage }) },
      ],
    };
  },
);

server.registerTool(
  "sandbox_ui_tree",
  {
    title: "Read the UI Automation tree",
    description:
      "Return the Windows UI Automation tree of the foreground window (or whole desktop) as " +
      "structured nodes: control type, name, automationId, bounding rect, a ready-to-use 'click' " +
      "point in REAL screen pixels, value, and an 'interactive' flag. Far cheaper than a screenshot " +
      "and gives precise click targets. Note: some apps (Chromium/CEF dialogs, custom-drawn UIs) " +
      "expose little here — fall back to sandbox_screenshot in that case.",
    inputSchema: {
      scope: z.enum(["window", "desktop"]).default("window").describe("Foreground window or the whole desktop."),
      onlyInteractive: z.boolean().default(false).describe("Return only buttons/inputs/toggles/list items."),
      maxDepth: z.number().int().positive().optional().describe("Tree depth cap (default 12)."),
      maxNodes: z.number().int().positive().optional().describe("Node cap (default 400); 'truncated' flags the cap."),
    },
  },
  async ({ scope, onlyInteractive, maxDepth, maxNodes }) => {
    const r = await sendCommand("ui_tree", { scope, onlyInteractive, maxDepth: maxDepth ?? 12, maxNodes: maxNodes ?? 400 }, 30000);
    return text(r.data);
  },
);

const selectorShape = {
  name: z.string().optional().describe("Match the element's Name (case-insensitive)."),
  automationId: z.string().optional().describe("Match the element's AutomationId (exact)."),
  controlType: z.string().optional().describe('Match control type, e.g. "Button", "CheckBox", "ListItem".'),
  match: z.enum(["contains", "exact"]).default("contains").describe("How to match Name."),
  scope: z.enum(["window", "desktop"]).default("window"),
};

server.registerTool(
  "sandbox_invoke",
  {
    title: "Actuate a UI element (no coordinates)",
    description:
      "Find a control by name/automationId/controlType and actuate it directly through UI " +
      "Automation — Invoke (buttons/links), Toggle (checkboxes), Select (list/radio items), " +
      "Expand/Collapse, or SetValue (text inputs). More robust than sandbox_click: no pixel math, " +
      "no dependence on window position or focus. action='auto' picks the right pattern; falls back " +
      "to a coordinate click if the element exposes none. Provide at least name or automationId. " +
      "Use sandbox_ui_tree first to discover names/ids. (CEF/custom apps expose no patterns — use " +
      "sandbox_click there.)",
    inputSchema: {
      ...selectorShape,
      index: z.number().int().min(0).default(0).describe("Which match if several (0-based)."),
      action: z
        .enum(["auto", "invoke", "toggle", "select", "expand", "collapse", "setvalue"])
        .default("auto"),
      value: z.string().optional().describe("Text to set (with action=setvalue, or auto when provided)."),
      fallbackClick: z.boolean().default(true).describe("Coordinate-click the center if no pattern is available."),
    },
  },
  async (args) => {
    if (!args.name && !args.automationId) throw new Error("sandbox_invoke requires 'name' and/or 'automationId'.");
    return text((await sendCommand("invoke", args, 30000)).data);
  },
);

server.registerTool(
  "sandbox_wait_for",
  {
    title: "Wait for a UI element",
    description:
      "Block until an element matching the selector is present (or, with absent=true, gone), or the " +
      "timeout elapses. Use this to synchronize instead of guessing sleeps after opening windows, " +
      "clicking, or navigating. Returns { satisfied, found, timedOut, waitedMs, rect, click, ... }; " +
      "satisfied=false means it timed out. Provide at least name or automationId.",
    inputSchema: {
      ...selectorShape,
      timeoutMs: z.number().int().positive().default(10000).describe("Max wait in ms."),
      pollMs: z.number().int().positive().default(200).describe("Poll interval in ms."),
      absent: z.boolean().default(false).describe("Wait until the element is NOT present."),
    },
  },
  async (args) => {
    if (!args.name && !args.automationId) throw new Error("sandbox_wait_for requires 'name' and/or 'automationId'.");
    // Give the socket call headroom beyond the in-guest wait so it doesn't time out first.
    return text((await sendCommand("wait_for", args, args.timeoutMs + 5000)).data);
  },
);

server.registerTool(
  "sandbox_ocr",
  {
    title: "OCR the screen (accessibility fallback)",
    description:
      "Recognize on-screen text with the built-in Windows OCR engine, returning lines and words " +
      "with bounding boxes and a ready-to-use 'click' point in REAL screen pixels. Use this when " +
      "sandbox_ui_tree returns nothing (Chromium/CEF dialogs, custom-drawn UIs, games) to locate " +
      "and click text by reading the pixels. Requires an OCR language in the Windows image; the " +
      "bare Windows Sandbox has none (the data is a Feature-on-Demand) and returns a clear error.",
    inputSchema: {
      region: z
        .array(z.number())
        .length(4)
        .optional()
        .describe("[x,y,w,h] real-screen crop to OCR; omit for the full screen."),
      language: z.string().optional().describe("BCP-47 tag, e.g. en-US (defaults to the profile language)."),
    },
  },
  async ({ region, language }) => text((await sendCommand("ocr", { region, language }, 30000)).data),
);

// ---- Input ---------------------------------------------------------------

server.registerTool(
  "sandbox_click",
  {
    title: "Click in the Sandbox",
    description:
      "Click at an absolute screen coordinate. Use the 'click' point from sandbox_ui_tree (real " +
      "screen pixels). If you measured a point off a screenshot instead, divide by the screenshot's " +
      "'scale' first to convert to real pixels.",
    inputSchema: {
      x: z.number().int().describe("X in real screen pixels."),
      y: z.number().int().describe("Y in real screen pixels."),
      button: z.enum(["left", "right", "middle"]).default("left"),
    },
  },
  async ({ x, y, button }) => text((await sendCommand("click", { x, y, button }, 30000)).data),
);

server.registerTool(
  "sandbox_double_click",
  {
    title: "Double-click",
    description: "Double-click at an absolute screen coordinate (real pixels).",
    inputSchema: { x: z.number().int(), y: z.number().int() },
  },
  async ({ x, y }) => text((await sendCommand("double_click", { x, y }, 30000)).data),
);

server.registerTool(
  "sandbox_scroll",
  {
    title: "Scroll the mouse wheel",
    description:
      "Scroll the wheel at a screen coordinate. ticks > 0 scrolls up, < 0 scrolls down (1 tick = one notch). " +
      "Position over the scrollable area first (e.g. a coordinate inside a long Settings page).",
    inputSchema: {
      x: z.number().int().describe("X in real screen pixels (over the area to scroll)."),
      y: z.number().int().describe("Y in real screen pixels."),
      ticks: z.number().int().default(-3).describe("Notches; positive = up, negative = down."),
    },
  },
  async ({ x, y, ticks }) => text((await sendCommand("scroll", { x, y, ticks }, 30000)).data),
);

server.registerTool(
  "sandbox_drag",
  {
    title: "Drag the mouse",
    description: "Press the left button at (fromX,fromY), move to (toX,toY), and release — for sliders, reordering, selection.",
    inputSchema: {
      fromX: z.number().int(),
      fromY: z.number().int(),
      toX: z.number().int(),
      toY: z.number().int(),
    },
  },
  async ({ fromX, fromY, toX, toY }) => text((await sendCommand("drag", { fromX, fromY, toX, toY }, 30000)).data),
);

server.registerTool(
  "sandbox_type",
  {
    title: "Type text",
    description: "Type text into the focused control (System.Windows.Forms.SendKeys). The right window/control must be focused first.",
    inputSchema: { text: z.string() },
  },
  async ({ text: t }) => text((await sendCommand("type", { text: t }, 30000)).data),
);

server.registerTool(
  "sandbox_key",
  {
    title: "Send special keys",
    description: "Send keystrokes in SendKeys syntax, e.g. {ENTER}, {ESC}, {TAB}, ^a (Ctrl+A), %{F4} (Alt+F4).",
    inputSchema: { keys: z.string().describe("SendKeys syntax.") },
  },
  async ({ keys }) => text((await sendCommand("key", { keys }, 30000)).data),
);

server.registerTool(
  "sandbox_open",
  {
    title: "Open an app, file, or URL",
    description:
      "Launch an executable, file path, or URI (including ms-settings: deep links) inside the Sandbox. " +
      "After launching it briefly watches the top-level windows: if the shell pops a failure / app-picker " +
      'dialog instead of the expected app ("We can\'t open this … link", "How do you want to open this file?", ' +
      '"No apps are installed", …) the result carries a non-null `warning` with that dialog\'s text — so you ' +
      "learn the target did not open (e.g. a UWP app absent from a vanilla Sandbox) without taking a screenshot. " +
      "`windows` lists the visible top-level window titles. A null `warning` means the launch looked clean.",
    inputSchema: { target: z.string().describe("Executable, file path, or URI.") },
  },
  async ({ target }) => text((await sendCommand("open", { target }, 30000)).data),
);

server.registerTool(
  "sandbox_run_ps",
  {
    title: "Run PowerShell in the Sandbox",
    description: "Run a PowerShell command inside the Sandbox and return its text output.",
    inputSchema: {
      command: z.string(),
      timeoutMs: z.number().int().positive().default(60000).describe("Maximum time to wait for the command result."),
    },
  },
  async ({ command, timeoutMs }) => text((await sendCommand("run_ps", { command, timeoutMs }, timeoutMs + 5000)).data),
);

server.registerTool(
  "sandbox_bridge_info",
  {
    title: "Show Sandbox bridge paths",
    description:
      "Return the active host and guest bridge paths, transport mode, artifact folders, and writability. " +
      "Use this when a task needs files copied into or out of the Sandbox.",
    inputSchema: {},
  },
  async () => text(await bridgeInfo()),
);

server.registerTool(
  "sandbox_stage_host_path",
  {
    title: "Stage a host file or folder into the Sandbox bridge",
    description:
      "Copy a host file or folder into the shared bridge processed folder and return both host and guest paths. " +
      "Use this before invoking guest-only tools when the original path is on a host drive such as W:\\ or C:\\Users.",
    inputSchema: {
      hostPath: z.string().describe("Host file or folder to copy into the Sandbox bridge."),
      destinationName: z
        .string()
        .optional()
        .describe("Optional destination folder/file name under bridge\\processed. Defaults to the source basename."),
      overwrite: z.boolean().default(true).describe("Replace an existing staged destination with the same name."),
    },
  },
  async ({ hostPath, destinationName, overwrite }) =>
    text(await stageHostPath({ hostPath, destinationName, overwrite })),
);

server.registerTool(
  "sandbox_find_install_candidates",
  {
    title: "Find installer candidates",
    description:
      "Scan the Sandbox Downloads folder (or a supplied path) for likely installer payloads and entry points. " +
      "Returns ranked .msi/.exe/.msix/.appx/.zip files with detected installer technology and evidence. " +
      "Use this as the first step when asked to figure out silent install switches for software dropped in Downloads.",
    inputSchema: {
      path: z.string().optional().describe("Guest path to scan. Defaults to the current user's Downloads folder."),
      recurse: z.boolean().default(true).describe("Scan recursively."),
    },
  },
  async ({ path, recurse }) => {
    await assertNoHostOnlyGuestPath(path, "path");
    return text((await sendCommand("installer_candidates", { path, recurse }, 60000)).data);
  },
);

server.registerTool(
  "sandbox_msi_inspect",
  {
    title: "Inspect an MSI",
    description:
      "Read MSI metadata directly from Windows Installer tables: ProductName, ProductVersion, ProductCode, " +
      "UpgradeCode, public properties, notable install/reboot/config properties, and a suggested msiexec /qn command.",
    inputSchema: {
      path: z.string().describe("Guest path to an .msi file."),
    },
  },
  async ({ path }) => {
    await assertNoHostOnlyGuestPath(path, "path");
    return text((await sendCommand("msi_inspect", { path }, 60000)).data);
  },
);

server.registerTool(
  "sandbox_analyze_installers",
  {
    title: "Analyze installer folder",
    description:
      "Analyze a folder of installer payloads, especially extracted vendor predeploy bundles. " +
      "Returns entry points, MSI package metadata, script evidence such as msiexec lines/properties, " +
      "recommended silent commands, and notes about properties like PRE_DEPLOY_DISABLE_VPN or LOCKDOWN.",
    inputSchema: {
      path: z.string().optional().describe("Guest folder to analyze. Defaults to the current user's Downloads folder."),
      recurse: z.boolean().default(true).describe("Scan recursively."),
    },
  },
  async ({ path, recurse }) => {
    await assertNoHostOnlyGuestPath(path, "path");
    return text((await sendCommand("installer_analyze", { path, recurse }, 90000)).data);
  },
);

server.registerTool(
  "sandbox_test_install_command",
  {
    title: "Test a silent installer command",
    description:
      "Run a proposed installer command in the Sandbox with a timeout and collect exit code, stdout/stderr, " +
      "new installed-program registry entries, visible top-level windows, pending-reboot indicators, and log tails. " +
      "Use this to verify that a candidate switch set is actually silent and successful.",
    inputSchema: {
      command: z.string().describe("Full command line to run inside PowerShell in the Sandbox."),
      timeoutMs: z.number().int().positive().default(120000).describe("Maximum time to wait before killing the process tree."),
      logPath: z.string().optional().describe("Optional expected installer log path to tail."),
      logTailLines: z.number().int().positive().default(80).describe("Number of lines to include from the main log."),
      workingDirectory: z.string().optional().describe("Optional guest working directory to run the command from."),
    },
  },
  async (args) =>
    text(
      (
        await sendCommand(
          "installer_test",
          args,
          Math.max(args.timeoutMs ?? 120000, 1000) + 30000,
        )
      ).data,
    ),
);

server.registerTool(
  "sandbox_verify_detection_rule",
  {
    title: "Verify an Intune-style detection rule",
    description:
      "Evaluate a detection rule inside the Sandbox and report whether it matches the expected state. " +
      "Supports MSI product code, registry, file/version, and PowerShell script rules. Use after install " +
      "and after uninstall to prove Intune detection will behave as expected.",
    inputSchema: {
      rule: z
        .any()
        .describe(
          "Detection rule object. Examples: {type:'msiProductCode', productCode:'{...}'}, {type:'registry', path:'HKLM:\\...', valueName:'DisplayVersion', operator:'equals', value:'1.2.3'}, {type:'file', path:'C:\\...', minVersion:'1.2.3'}, or {type:'script', script:'...'}",
        ),
      expectedPresent: z.boolean().default(true).describe("true expects detection to match; false expects it not to match."),
      timeoutMs: z.number().int().positive().default(30000).describe("Timeout for script detection rules."),
    },
  },
  async (args) => text((await sendCommand("detection_verify", args, Math.max(args.timeoutMs ?? 30000, 1000) + 5000)).data),
);

const assertionSchema = z
  .object({
    type: z
      .enum(["file", "registry", "msiProductCode", "script", "process", "service", "window", "installedProgram"])
      .describe("Assertion kind."),
    label: z.string().optional().describe("Human-readable name shown in reports; defaults to the type."),
    expectedPresent: z.boolean().default(true).describe("true expects a match; false expects the opposite (e.g. proving uninstall residue is gone)."),
  })
  .passthrough()
  .describe(
    "One assertion. Type-specific fields (passthrough): " +
      "file {path, version?|minVersion?}; registry {path, valueName?, operator?(exists|equals|contains|notEquals), value?}; " +
      "msiProductCode {productCode, productVersion?}; script {script|command, } (exit 0 = detected); " +
      "process {name}; service {name, status?(Running|Stopped)}; window {title, match?(contains|exact)}; " +
      "installedProgram {name (contains), minVersion?}.",
  );

server.registerTool(
  "sandbox_assert",
  {
    title: "Assert sandbox state (pass/fail)",
    description:
      "Evaluate one or more assertions about the Sandbox state and return a normalized pass/fail roll-up. " +
      "Building block for verification and for sandbox_run_test_plan. Each assertion's 'passed' honors " +
      "expectedPresent, so you can assert both presence (after install) and absence (after uninstall). " +
      "Supports file/registry/msiProductCode/script (same engine as detection rules) plus process, service, " +
      "window, and installedProgram checks.",
    inputSchema: {
      assertions: z.array(assertionSchema).min(1).describe("Assertions to evaluate."),
      timeoutMs: z.number().int().positive().default(30000).describe("Timeout for script assertions."),
    },
  },
  async (args) => text((await sendCommand("assert", args, Math.max(args.timeoutMs ?? 30000, 1000) + 5000)).data),
);

const testStepSchema = z.object({
  name: z.string().describe("Step name shown in the report (becomes a JUnit testcase)."),
  open: z.string().optional().describe("Launch an app/file/URI before asserting (sandbox_open)."),
  run: z.string().optional().describe("PowerShell/command line to run; its exit code gates the step (see expectExitCode)."),
  runTimeoutMs: z.number().int().positive().optional().describe("Timeout for 'run' (default 120000)."),
  expectExitCode: z.number().int().optional().describe("Exit code that counts as success for 'run' (default 0)."),
  assert: z.array(assertionSchema).optional().describe("Assertions evaluated after the action; any failure fails the step."),
  assertTimeoutMs: z.number().int().positive().optional().describe("Timeout for script assertions (default 30000)."),
  capture: z
    .object({
      caption: z.string().optional(),
      window: z.boolean().optional().describe("Capture only the foreground window."),
      region: z.array(z.number()).length(4).optional().describe("[x,y,w,h] real-screen crop."),
    })
    .optional()
    .describe("Capture a screenshot for the doc-mode summary.md."),
  continueOnFailure: z.boolean().optional().describe("Keep running later steps even if this one fails (default false: remaining steps are skipped)."),
});

server.registerTool(
  "sandbox_run_test_plan",
  {
    title: "Run a declarative test plan",
    description:
      "Run an ordered list of steps in the Sandbox and produce a pass/fail report. Each step can launch " +
      "something (open), run a command whose exit code is checked (run/expectExitCode), assert state " +
      "(file/registry/process/service/window/installedProgram/msiProductCode/script), and capture a " +
      "screenshot. By default a failing step skips the rest (continueOnFailure to override). Writes " +
      "junit.xml (for CI), results.json, and a screenshot-embedded summary.md under " +
      "bridge\\artifacts\\testplans\\<runId> and returns the roll-up plus host paths. This is the same " +
      "definition you can re-run as a regression test or read as documentation.",
    inputSchema: {
      name: z.string().describe("Test plan name (used in the report and the run folder)."),
      steps: z.array(testStepSchema).min(1).describe("Ordered steps."),
    },
  },
  async ({ name, steps }) =>
    text(
      await runTestPlan(
        { sendCommand, screenshot, bridgeRoot, toBridgeHostPath },
        { name, steps },
        new Date().toISOString(),
      ),
    ),
);

server.registerTool(
  "sandbox_snapshot",
  {
    title: "Capture a system-state snapshot",
    description:
      "Capture a baseline of the Sandbox state — files under common install roots, registry values " +
      "under install-related keys, installed programs, and services — and persist it to the shared " +
      "bridge. Take one before an install and one after, then diff them with sandbox_diff_snapshots to " +
      "see exactly what the installer changed (also powers uninstall-residue checks and auto-docs). " +
      "Because a fresh Sandbox is nearly empty, an app's footprint stands out clearly. Returns a " +
      "snapshotId, per-section counts, and host paths.",
    inputSchema: {
      label: z.string().optional().describe("Human-readable label, e.g. 'before-install' / 'after-install'."),
      includeFiles: z.boolean().default(true),
      includeRegistry: z.boolean().default(true),
      includePrograms: z.boolean().default(true),
      includeServices: z.boolean().default(true),
      fileRoots: z.array(z.string()).optional().describe("Override the default file roots (Program Files, ProgramData, AppData, Start Menu, …)."),
      registryRoots: z.array(z.string()).optional().describe("Override the default registry roots (Uninstall + Run keys)."),
      maxFiles: z.number().int().positive().default(200000).describe("Cap on enumerated files; sets a truncated flag if hit."),
      maxRegistryValues: z.number().int().positive().default(50000).describe("Cap on enumerated registry values; sets a truncated flag if hit."),
    },
  },
  async (args) => text(addBridgeHostPaths((await sendCommand("snapshot_capture", args, 300000)).data)),
);

server.registerTool(
  "sandbox_diff_snapshots",
  {
    title: "Diff two system-state snapshots",
    description:
      "Compare two snapshots captured by sandbox_snapshot and report what changed across files, " +
      "registry values, installed programs, and services (added / removed / changed). Writes diff.json " +
      "and a human-readable diff.md under bridge\\artifacts\\snapshots\\diffs\\<diffId> and returns the " +
      "counts plus a capped inline payload. Use after install to document the footprint, or after " +
      "uninstall (before vs a clean baseline) to find leftover residue.",
    inputSchema: {
      beforeId: z.string().describe("snapshotId of the earlier snapshot."),
      afterId: z.string().describe("snapshotId of the later snapshot."),
    },
  },
  async ({ beforeId, afterId }) =>
    text(await diffSnapshots({ bridgeRoot }, beforeId, afterId, new Date().toISOString())),
);

server.registerTool(
  "sandbox_start_job",
  {
    title: "Start a long-running PowerShell job",
    description:
      "Start a PowerShell command inside the Sandbox and return immediately with a jobId. " +
      "Use for long installers or scripts that may exceed normal MCP call timeouts, then poll with sandbox_job_status.",
    inputSchema: {
      command: z.string().describe("PowerShell command or script to run inside the Sandbox."),
      timeoutMs: z.number().int().positive().default(600000).describe("Maximum runtime before sandbox_job_status marks it timed out and kills it."),
      workingDirectory: z.string().optional().describe("Optional guest working directory to run the command from."),
    },
  },
  async (args) => text(addBridgeHostPaths((await sendCommand("job_start_ps", args, 30000)).data)),
);

server.registerTool(
  "sandbox_job_status",
  {
    title: "Check a Sandbox job",
    description:
      "Return status for a job started by sandbox_start_job, including exit code, timeout/cancel state, " +
      "stdout/stderr tails, and host paths to the persisted job artifacts.",
    inputSchema: {
      jobId: z.string().describe("Job id returned by sandbox_start_job."),
      tailLines: z.number().int().positive().default(80).describe("Number of stdout/stderr lines to include."),
    },
  },
  async (args) => text(addBridgeHostPaths((await sendCommand("job_status", args, 30000)).data)),
);

server.registerTool(
  "sandbox_job_cancel",
  {
    title: "Cancel a Sandbox job",
    description: "Kill a running job started by sandbox_start_job and return its final status/log tails.",
    inputSchema: {
      jobId: z.string().describe("Job id returned by sandbox_start_job."),
    },
  },
  async (args) => text(addBridgeHostPaths((await sendCommand("job_cancel", args, 30000)).data)),
);

server.registerTool(
  "sandbox_intune_package_from_host",
  {
    title: "Stage and package a host folder for Intune",
    description:
      "Copy a host source folder into the Sandbox bridge, run IntuneWinAppUtil.exe inside the Sandbox, " +
      "and return .intunewin package host paths plus Intune deployment metadata. " +
      "Use this for normal host paths such as W:\\Software\\App or C:\\Users\\... without manually finding the bridge.",
    inputSchema: {
      sourceHostFolder: z.string().describe("Host folder containing all source files to package."),
      setupFile: z.string().describe("Setup file inside sourceHostFolder, relative path preferred."),
      destinationName: z
        .string()
        .optional()
        .describe("Optional staging folder name under bridge\\processed. Defaults to the source folder basename."),
      outputHostFolder: z
        .string()
        .optional()
        .describe("Optional host folder to copy the final .intunewin package(s) into after packaging."),
      installCommand: z.string().optional().describe("Optional Intune install command to carry into the summary."),
      uninstallCommand: z.string().optional().describe("Optional Intune uninstall command to carry into the summary."),
      detectionRule: z.any().optional().describe("Optional detection rule to verify; defaults to MSI metadata when setupFile is an MSI."),
      testInstall: z
        .boolean()
        .default(true)
        .describe("Run the install command in the Sandbox before packaging; packaging is skipped if the test fails."),
      installTestTimeoutMs: z.number().int().positive().default(90000).describe("Install preflight timeout in milliseconds."),
      verifyDetection: z.boolean().default(true).describe("Verify the detection rule after install and, when uninstall is tested, after uninstall."),
      testUninstall: z.boolean().default(true).describe("Run the uninstall command after a successful install/detection preflight."),
      uninstallTestTimeoutMs: z.number().int().positive().default(90000).describe("Uninstall preflight timeout in milliseconds."),
      ensureTool: z.boolean().default(true).describe("Download the official tool if it is missing."),
      toolPath: z.string().optional().describe("Optional guest path to an existing IntuneWinAppUtil.exe."),
      downloadUrl: z
        .string()
        .optional()
        .describe("Optional Microsoft GitHub URL override. Defaults to the official raw IntuneWinAppUtil.exe URL."),
      quiet: z.boolean().default(true).describe("Pass -q to IntuneWinAppUtil.exe."),
      includeCatalog: z.boolean().default(false).describe("Pass -a to include catalog files."),
      timeoutMs: z.number().int().positive().default(300000).describe("Packaging timeout in milliseconds."),
    },
  },
  async (args) => {
    const staged = await stageHostPath({
      hostPath: args.sourceHostFolder,
      destinationName: args.destinationName,
      overwrite: true,
    });
    const packageResult = addBridgeHostPaths(
      (
        await sendCommand(
          "intune_package",
          {
            sourceFolder: staged.guestPath,
            setupFile: args.setupFile,
            installCommand: args.installCommand,
            uninstallCommand: args.uninstallCommand,
            detectionRule: args.detectionRule,
            testInstall: args.testInstall,
            installTestTimeoutMs: args.installTestTimeoutMs,
            verifyDetection: args.verifyDetection,
            testUninstall: args.testUninstall,
            uninstallTestTimeoutMs: args.uninstallTestTimeoutMs,
            ensureTool: args.ensureTool,
            toolPath: args.toolPath,
            downloadUrl: args.downloadUrl,
            quiet: args.quiet,
            includeCatalog: args.includeCatalog,
            timeoutMs: args.timeoutMs,
          },
          Math.max(
            args.timeoutMs ?? 300000,
            args.installTestTimeoutMs ?? 90000,
            args.uninstallTestTimeoutMs ?? 90000,
            1000,
          ) + 30000,
        )
      ).data,
    );
    let copiedPackages: any[] = [];
    if (args.outputHostFolder) {
      copiedPackages = await copyPackagesToHostFolder(packageResult.packages ?? [], args.outputHostFolder);
    }
    return text({
      stagedSource: staged,
      packaging: packageResult,
      copiedPackages,
    });
  },
);

server.registerTool(
  "sandbox_intune_prereqs",
  {
    title: "Resolve Intune Win32 packaging tool",
    description:
      "Check for IntuneWinAppUtil.exe in the Sandbox shared tools folder, Downloads, or TEMP. " +
      "With ensureTool=true, download it from Microsoft's official Win32 Content Prep Tool GitHub repo " +
      "into the shared tools folder so it can be reused.",
    inputSchema: {
      ensureTool: z.boolean().default(true).describe("Download the official tool if it is missing."),
      toolPath: z.string().optional().describe("Optional guest path to an existing IntuneWinAppUtil.exe."),
      downloadUrl: z
        .string()
        .optional()
        .describe("Optional Microsoft GitHub URL override. Defaults to the official raw IntuneWinAppUtil.exe URL."),
    },
  },
  async ({ ensureTool, toolPath, downloadUrl }) =>
    text(addBridgeHostPaths((await sendCommand("intune_prereqs", { ensureTool, toolPath, downloadUrl }, 120000)).data)),
);

server.registerTool(
  "sandbox_intune_package_win32",
  {
    title: "Package a Win32 app for Intune",
    description:
      "Create a .intunewin package inside the Sandbox using IntuneWinAppUtil.exe. " +
      "The tool can auto-download the official Microsoft utility if needed, keeps it outside the source folder, " +
      "writes packages to the shared bridge artifacts/intune folder by default, and returns host paths plus " +
      "deployment metadata suggestions such as install/uninstall commands, detection rule, and return codes.",
    inputSchema: {
      sourceFolder: z.string().describe("Guest folder containing all source files to package."),
      setupFile: z.string().describe("Setup file inside sourceFolder, relative path preferred."),
      outputFolder: z
        .string()
        .optional()
        .describe("Guest output folder. Defaults to C:\\SandboxBridge\\artifacts\\intune."),
      installCommand: z.string().optional().describe("Optional Intune install command to carry into the summary."),
      uninstallCommand: z.string().optional().describe("Optional Intune uninstall command to carry into the summary."),
      detectionRule: z.any().optional().describe("Optional detection rule to verify; defaults to MSI metadata when setupFile is an MSI."),
      testInstall: z
        .boolean()
        .default(true)
        .describe("Run the install command in the Sandbox before packaging; packaging is skipped if the test fails."),
      installTestTimeoutMs: z.number().int().positive().default(90000).describe("Install preflight timeout in milliseconds."),
      verifyDetection: z.boolean().default(true).describe("Verify the detection rule after install and, when uninstall is tested, after uninstall."),
      testUninstall: z.boolean().default(true).describe("Run the uninstall command after a successful install/detection preflight."),
      uninstallTestTimeoutMs: z.number().int().positive().default(90000).describe("Uninstall preflight timeout in milliseconds."),
      ensureTool: z.boolean().default(true).describe("Download the official tool if it is missing."),
      toolPath: z.string().optional().describe("Optional guest path to an existing IntuneWinAppUtil.exe."),
      downloadUrl: z
        .string()
        .optional()
        .describe("Optional Microsoft GitHub URL override. Defaults to the official raw IntuneWinAppUtil.exe URL."),
      quiet: z.boolean().default(true).describe("Pass -q to IntuneWinAppUtil.exe."),
      includeCatalog: z.boolean().default(false).describe("Pass -a to include catalog files."),
      timeoutMs: z.number().int().positive().default(300000).describe("Packaging timeout in milliseconds."),
    },
  },
  async (args) =>
    {
      await assertNoHostOnlyGuestPath(args.sourceFolder, "sourceFolder");
      await assertNoHostOnlyGuestPath(args.outputFolder, "outputFolder");
      return text(
        addBridgeHostPaths(
          (
            await sendCommand(
              "intune_package",
              args,
              Math.max(
                args.timeoutMs ?? 300000,
                args.installTestTimeoutMs ?? 90000,
                args.uninstallTestTimeoutMs ?? 90000,
                1000,
              ) + 30000,
            )
          ).data,
        ),
      );
    },
);

server.registerTool(
  "sandbox_center_window",
  {
    title: "Center the foreground window",
    description: "Move the foreground window to the center of the working area (nicer framing for screenshots).",
    inputSchema: {},
  },
  async () => text((await sendCommand("center_window", {}, 30000)).data),
);

server.registerTool(
  "sandbox_health",
  {
    title: "Agent health check",
    description:
      "Quick liveness probe: confirms the guest agent responds and reports transport, pid, screen " +
      "size, whether the session is headless (200x200 — capture/OCR won't work until reconnected), " +
      "and the foreground window name.",
    inputSchema: {},
  },
  async () => text((await sendCommand("health", {}, 10000)).data),
);

// ---- Annotation ----------------------------------------------------------

const shapeSchema = z
  .object({
    type: z.enum(["box", "arrow", "label", "spotlight"]),
    rect: z.array(z.number()).length(4).optional().describe("[x,y,w,h] for box/spotlight."),
    from: z.array(z.number()).length(2).optional().describe("[x,y] arrow start."),
    to: z.array(z.number()).length(2).optional().describe("[x,y] arrow tip."),
    at: z.array(z.number()).length(2).optional().describe("[x,y] label top-left."),
    text: z.string().optional(),
    color: z.string().optional().describe("Hex (#RRGGBB) or name; default red."),
    bg: z.string().optional().describe("Label background color."),
    thickness: z.number().optional(),
    size: z.number().optional().describe("Label font size."),
    dim: z.number().optional().describe("Spotlight backdrop alpha 0-255."),
  })
  .passthrough();

server.registerTool(
  "sandbox_annotate",
  {
    title: "Annotate a screenshot",
    description:
      "Draw boxes / arrows / labels / spotlight onto a previously captured screenshot and return the " +
      "annotated image inline. mode='screen' takes coordinates in real screen pixels (pair with " +
      "sandbox_ui_tree rects) and maps them via the capture metadata. mode='image' takes coordinates " +
      "in the screenshot's own pixels (read straight off the JPEG) — use this for apps with no UI tree.",
    inputSchema: {
      inputPath: z.string().describe("Host path of the screenshot (the 'hostPath' from sandbox_screenshot)."),
      mode: z.enum(["screen", "image"]).default("image"),
      metadataPath: z.string().optional().describe("Capture metadata path; defaults to inputPath with .json. Required-ish for screen mode."),
      shapes: z.array(shapeSchema).describe("Shapes to draw."),
      outputPath: z.string().optional().describe("Where to write; defaults to inputPath with -annotated suffix."),
    },
  },
  async ({ inputPath, mode, metadataPath, shapes, outputPath }) => {
    const out = await annotate({ inputPath, mode, metadataPath, shapes, outputPath });
    return {
      content: [
        { type: "image", data: out.base64, mimeType: out.mimeType },
        { type: "text", text: JSON.stringify({ hostPath: out.hostPath, mode }) },
      ],
    };
  },
);

// ---- Lifecycle -----------------------------------------------------------

server.registerTool(
  "sandbox_status",
  {
    title: "List running Sandboxes",
    description: "List running Windows Sandbox environments (via wsb).",
    inputSchema: {},
  },
  async () => text(await runBridgeAction("list")),
);

server.registerTool(
  "sandbox_prepare",
  {
    title: "Prepare a Sandbox for control",
    description:
      "One call to get a control-ready Windows Sandbox: start or reuse one, open the interactive " +
      "session and set a clean 1920x1080 desktop resolution (so screenshots are not a tiny postage " +
      "stamp or microscopic), apply Google DNS for internet, and start the guest control " +
      "agent. With SANDBOX_TRANSPORT=socket this starts the socket agent and waits until it has " +
      "published its endpoint (returns ready=true); otherwise it starts the file-mode agent. " +
      "By default it REUSES an already-running Sandbox (fast — no ~60s boot), so guest state from " +
      "an earlier session persists. Pass fresh=true to destroy any running Sandbox first and boot a " +
      "clean one. Run this once before driving the UI.",
    inputSchema: {
      fresh: z
        .boolean()
        .optional()
        .describe("Destroy any running Sandbox first and boot a clean VM (no leftover state)."),
    },
  },
  async ({ fresh }) => {
    const action = process.env.SANDBOX_TRANSPORT === "socket" ? "prepare-socket" : "prepare-guide";
    return text(await runBridgeAction(action, fresh ? ["-Fresh"] : []));
  },
);

server.registerTool(
  "sandbox_stop",
  {
    title: "Stop (reset) the Sandbox",
    description:
      "Destroy the Windows Sandbox VM — a real reset that wipes all guest state. Because wsb starts " +
      "the VM detached, closing the interactive window only closes the viewer; the VM keeps running " +
      "until stopped here. With no id, stops every running Sandbox. After this, sandbox_prepare boots " +
      "a clean one.",
    inputSchema: {
      id: z.string().optional().describe("Specific Sandbox id to stop. Omit to stop all running ones."),
    },
  },
  async ({ id }) => text(await runBridgeAction("stop", id ? ["-SandboxId", id] : [])),
);

server.registerTool(
  "sandbox_set_resolution",
  {
    title: "Set the guest screen resolution",
    description:
      "Resize the Windows Sandbox desktop to a clean, deterministic resolution (default 1920x1080). " +
      "The guest is an RDP session whose size tracks the host window, and it sometimes boots at a tiny " +
      "fallback (e.g. 200x200 or 640x480 — a postage-stamp desktop) or, on a high-DPI host, an enormous " +
      "resolution where everything is microscopic. sandbox_prepare already applies this, but call it " +
      "yourself if sandbox_health reports a small or huge screen and your screenshots look wrong.",
    inputSchema: {
      width: z.number().int().optional().describe("Target width in pixels (default 1920)."),
      height: z.number().int().optional().describe("Target height in pixels (default 1080)."),
    },
  },
  async ({ width, height }) => {
    const args: string[] = [];
    if (width != null) args.push("-Width", String(width));
    if (height != null) args.push("-Height", String(height));
    return text(await runBridgeAction("set-resolution", args));
  },
);

// ---- Guide builder -------------------------------------------------------

const guidesDir = path.join(bridgeRoot, "guides");
const guideDirFor = (name: string) => path.join(guidesDir, name.replace(/[^a-z0-9_-]/gi, "_"));

async function readSteps(dir: string): Promise<any[]> {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, "steps.json"), "utf8"));
  } catch {
    return [];
  }
}

server.registerTool(
  "sandbox_guide_step",
  {
    title: "Record a guide step",
    description:
      "Capture a screenshot, optionally annotate it (boxes/arrows/labels in real screen coords), " +
      "and append it as a numbered step with a caption to a named guide. Build the final document " +
      "with sandbox_guide_build. Use window/region to focus the shot on the relevant UI.",
    inputSchema: {
      guide: z.string().describe("Guide name (a folder under bridge/guides)."),
      caption: z.string().describe("Instruction text shown above this step's screenshot."),
      window: z.boolean().optional().describe("Capture only the foreground window."),
      region: z.array(z.number()).length(4).optional().describe("[x,y,w,h] real-screen crop."),
      shapes: z.array(shapeSchema).optional().describe("Optional annotations (screen-coord boxes/arrows/labels)."),
    },
  },
  async ({ guide, caption, window, region, shapes }) => {
    const dir = guideDirFor(guide);
    await fsp.mkdir(dir, { recursive: true });
    const steps = await readSteps(dir);
    const n = steps.length + 1;
    const nn = String(n).padStart(2, "0");

    const shot = await screenshot({ window, region });
    const rawPath = path.join(dir, `step-${nn}-raw.jpg`);
    await fsp.writeFile(rawPath, Buffer.from(shot.base64, "base64"));

    let image = `step-${nn}-raw.jpg`;
    if (shapes && shapes.length) {
      const outPath = path.join(dir, `step-${nn}.jpg`);
      await annotate({ inputPath: rawPath, outputPath: outPath, shapes, mode: "screen", metadataPath: shot.metadataPath });
      image = `step-${nn}.jpg`;
    }

    steps.push({ n, caption, image });
    await fsp.writeFile(path.join(dir, "steps.json"), JSON.stringify(steps, null, 2), "utf8");
    return text({ guide, step: n, image, totalSteps: steps.length });
  },
);

server.registerTool(
  "sandbox_guide_build",
  {
    title: "Build the guide document",
    description: "Assemble the recorded steps of a named guide into a Markdown file with embedded screenshots.",
    inputSchema: {
      guide: z.string(),
      title: z.string().optional().describe("Document title (defaults to the guide name)."),
    },
  },
  async ({ guide, title }) => {
    const dir = guideDirFor(guide);
    const steps = await readSteps(dir);
    if (!steps.length) throw new Error(`No steps recorded for guide '${guide}'. Use sandbox_guide_step first.`);
    let md = `# ${title ?? guide}\n\n`;
    for (const s of steps) {
      md += `## Step ${s.n}\n\n${s.caption}\n\n![Step ${s.n}](${s.image})\n\n`;
    }
    const mdPath = path.join(dir, `${path.basename(dir)}.md`);
    await fsp.writeFile(mdPath, md, "utf8");
    return text({ guide, mdPath, steps: steps.length });
  },
);

server.registerTool(
  "sandbox_guide_reset",
  {
    title: "Reset a guide",
    description: "Delete all recorded steps and images for a named guide so you can re-record it.",
    inputSchema: { guide: z.string() },
  },
  async ({ guide }) => {
    const dir = guideDirFor(guide);
    await fsp.rm(dir, { recursive: true, force: true });
    return text({ guide, reset: true });
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = process.env.SANDBOX_TRANSPORT === "socket" ? "socket" : "file";
  console.error(`[sandbox-pilot] connected. transport=${mode} bridgeRoot=${bridgeRoot}`);
}

main().catch((err) => {
  console.error("[windows-sandbox-mcp] fatal:", err);
  process.exit(1);
});
