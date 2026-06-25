#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { annotate, bridgeInfo, runBridgeAction, stageHostPath, toBridgeHostPath, bridgeRoot, projectRoot } from "./bridge.js";
import * as fileBridge from "./bridge.js";
import * as socketBridge from "./socket-bridge.js";
import { runTestPlan } from "./testplan.js";
import { diffSnapshots } from "./snapshot.js";
import { buildGuideDocs } from "./guidedoc.js";
import { cleanupArtifacts } from "./cleanup.js";
import { buildPackagingDossier } from "./dossier.js";
import { runEmailUrlPhishingTest } from "./phishing.js";

// Transport: "socket" (low latency, guest listens / host connects out) or the default
// file bridge (shared folder; simpler but ~20s host->guest propagation).
const TRANSPORT = process.env.SANDBOX_TRANSPORT === "socket" ? socketBridge : fileBridge;
const sendCommand = TRANSPORT.sendCommand;
const screenshot = TRANSPORT.screenshot;

const SERVER_VERSION = "0.7.0";
// Bump only on a breaking change to the guest command/result contract. sandbox_health compares
// this with the value the guest agent reports, so a stale agent surfaces as a clear warning.
const EXPECTED_GUEST_PROTOCOL = 1;

const server = new McpServer({
  name: "sandbox-pilot",
  version: SERVER_VERSION,
});

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const workflowResources: Record<string, { title: string; description: string; text: string }> = {
  "sandbox-pilot://workflows/intune-packaging": {
    title: "Intune Packaging Workflow",
    description: "Recommended end-to-end workflow for proving and packaging a Win32 app.",
    text:
      "# Intune Packaging Workflow\n\n" +
      "1. Call sandbox_prepare with fresh=true when clean state matters.\n" +
      "2. Use sandbox_find_install_candidates or sandbox_analyze_installers to identify setup technology and silent commands.\n" +
      "3. Call sandbox_test_intune_deployment with sourceHostFolder, installCommand, uninstallCommand, detectionRule, installContext=system, and architecture=x64.\n" +
      "4. Review deployment.verdict, failures, blockingWindows, footprint, and residue before packaging.\n" +
      "5. Call sandbox_intune_package_from_host only after the IME simulation passes.\n" +
      "6. Call sandbox_build_packaging_dossier with the deployment and packaging results for the handoff artifact.\n",
  },
  "sandbox-pilot://workflows/psadt-packaging": {
    title: "PSADT Packaging Workflow",
    description: "Recommended workflow for scaffolding a PowerShell App Deployment Toolkit (PSADT) package.",
    text:
      "# PSADT Packaging Workflow\n\n" +
      "1. Call sandbox_prepare (fresh=true for clean state).\n" +
      "2. Call sandbox_psadt_prereqs to download/cache the PSADT template (default v4 4.1.8).\n" +
      "3. Call sandbox_psadt_build with appName, appVersion, appVendor, sourceHostFolder (the installer payload), " +
      "and setupFile (so the install/uninstall command can be inferred). Set useCompanyTemplate=true to overlay " +
      "the company branding template (logos/banners/config), or pass templateHostFolder to point at a specific one.\n" +
      "4. Leave testInstall=true to prove the PSADT package installs (and uninstalls) inside the Sandbox.\n" +
      "5. Set packageIntunewin=true to also wrap the package into a .intunewin (setupFile=Invoke-AppDeployToolkit.exe).\n" +
      "6. Optionally call sandbox_build_packaging_dossier over the result for the handoff artifact.\n",
  },
  "sandbox-pilot://workflows/user-guide": {
    title: "User Guide Workflow",
    description: "Recommended workflow for creating a screenshot user guide from a Sandbox run.",
    text:
      "# User Guide Workflow\n\n" +
      "1. Call sandbox_prepare and open the target app or Windows settings page.\n" +
      "2. Call sandbox_record_start with a descriptive guide name.\n" +
      "3. Prefer sandbox_ui_tree plus sandbox_invoke for stable actions; use screenshots/OCR only when UIA is empty.\n" +
      "4. Use sandbox_annotate or sandbox_guide_step for deliberate callouts and redactions.\n" +
      "5. Call sandbox_record_stop, then sandbox_guide_build with markdown/html/pdf as needed.\n",
  },
  "sandbox-pilot://schemas/detection-rule": {
    title: "Detection Rule Schema",
    description: "Detection-rule shapes accepted by detection verification and Intune deployment testing.",
    text:
      "# Detection Rule Shapes\n\n" +
      "MSI product code:\n```json\n{\"type\":\"msiProductCode\",\"productCode\":\"{GUID}\",\"productVersion\":\"1.2.3\"}\n```\n\n" +
      "Registry value or key presence:\n```json\n{\"type\":\"registry\",\"path\":\"HKLM:\\\\Software\\\\...\",\"valueName\":\"DisplayVersion\",\"operator\":\"equals\",\"value\":\"1.2.3\"}\n```\n\n" +
      "File path/version:\n```json\n{\"type\":\"file\",\"path\":\"C:\\\\Program Files\\\\App\\\\app.exe\",\"version\":\"1.2.3\",\"operator\":\"greaterOrEqual\"}\n```\n\n" +
      "PowerShell script detection:\n```json\n{\"type\":\"script\",\"script\":\"if (Test-Path 'C:\\\\Program Files\\\\App\\\\app.exe') { exit 0 } else { exit 1 }\"}\n```\n",
  },
};

for (const [uri, resource] of Object.entries(workflowResources)) {
  server.registerResource(
    uri.split("/").pop() ?? uri,
    uri,
    { title: resource.title, description: resource.description, mimeType: "text/markdown" },
    async (requestUri) => ({
      contents: [{ uri: requestUri.toString(), mimeType: "text/markdown", text: resource.text }],
    }),
  );
}

server.registerPrompt(
  "intune_package_app_from_folder",
  {
    title: "Package App From Folder",
    description: "Guide an agent through analysis, IME simulation, packaging, and dossier generation for a Win32 app folder.",
    argsSchema: {
      sourceHostFolder: z.string().describe("Host folder containing the source files."),
      appName: z.string().optional().describe("Friendly app name."),
      setupFile: z.string().optional().describe("Known setup file, if already identified."),
    },
  },
  async ({ sourceHostFolder, appName, setupFile }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Package ${appName ?? "this app"} for Intune from ${sourceHostFolder}.\n\n` +
            `${setupFile ? `Known setup file: ${setupFile}\n\n` : ""}` +
            "Use Sandbox Pilot's workflow: prepare a clean Sandbox, analyze installer candidates, infer or ask for install/uninstall commands, run sandbox_test_intune_deployment as system/x64 with detection verification, package only after the simulation passes, then build a packaging dossier.",
        },
      },
    ],
  }),
);

server.registerPrompt(
  "silent_install_test_workflow",
  {
    title: "Silent Install Test",
    description: "Guide an agent through validating a proposed silent install/uninstall pair.",
    argsSchema: {
      sourceHostFolder: z.string().describe("Host folder containing installer source."),
      installCommand: z.string().describe("Proposed silent install command."),
      uninstallCommand: z.string().optional().describe("Proposed silent uninstall command."),
    },
  },
  async ({ sourceHostFolder, installCommand, uninstallCommand }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Validate this Intune silent install from ${sourceHostFolder}.\n\n` +
            `Install command: ${installCommand}\n` +
            `Uninstall command: ${uninstallCommand ?? "(not supplied)"}\n\n` +
            "Run sandbox_test_intune_deployment with event-log collection and detection verification when a rule is available. Report exit codes, blocking UI, detection behavior, footprint, residue, and whether it is Intune-ready.",
        },
      },
    ],
  }),
);

server.registerPrompt(
  "user_guide_creation_workflow",
  {
    title: "Create User Guide",
    description: "Guide an agent through recording a screenshot-based user guide in the Sandbox.",
    argsSchema: {
      guideName: z.string().describe("Guide artifact name."),
      task: z.string().describe("Procedure to perform and document."),
    },
  },
  async ({ guideName, task }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Create a user guide named ${guideName} for this task: ${task}\n\n` +
            "Use sandbox_record_start, drive the UI with UI Automation where possible, add manual annotated/redacted steps when useful, stop recording, and build Markdown plus HTML output.",
        },
      },
    ],
  }),
);

server.registerPrompt(
  "psadt_package_app",
  {
    title: "Package App with PSADT",
    description: "Guide an agent through fetching PSADT, scaffolding a deployment package, applying company branding, and proving it.",
    argsSchema: {
      appName: z.string().describe("Application name."),
      sourceHostFolder: z.string().describe("Host folder containing the installer payload."),
      setupFile: z.string().optional().describe("Setup file inside sourceHostFolder (drives install-command inference)."),
      appVersion: z.string().optional().describe("Application version."),
      appVendor: z.string().optional().describe("Application vendor."),
    },
  },
  async ({ appName, sourceHostFolder, setupFile, appVersion, appVendor }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Package ${appName} as a PSADT (PowerShell App Deployment Toolkit) deployment from ${sourceHostFolder}.\n\n` +
            `${setupFile ? `Setup file: ${setupFile}\n` : ""}` +
            `${appVersion ? `Version: ${appVersion}\n` : ""}` +
            `${appVendor ? `Vendor: ${appVendor}\n` : ""}\n` +
            "Use sandbox_psadt_build: scaffold the PSADT v4 template, copy the installer into Files\\, set app metadata and " +
            "the install/uninstall commands, overlay the company branding template (useCompanyTemplate=true), test-install in " +
            "the Sandbox, and wrap the result into a .intunewin (packageIntunewin=true). Report the package folder, applied " +
            "branding, test result, and the .intunewin path.",
        },
      },
    ],
  }),
);

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

// ---- PSADT (PowerShell App Deployment Toolkit) ----------------------------
const PSADT_DEFAULT_VERSION = "4.1.8";
// Company branding overlay: an explicit per-call host folder wins; otherwise the SANDBOX_PSADT_TEMPLATE
// env var; otherwise the baked-in skeleton committed to the repo (assets/psadt-template).
const psadtDefaultTemplateDir = path.join(projectRoot, "assets", "psadt-template");

async function resolvePsadtTemplateHostFolder(
  templateHostFolder: string | undefined,
  useCompanyTemplate: boolean,
): Promise<string | null> {
  if (templateHostFolder) return templateHostFolder;
  if (!useCompanyTemplate) return null;
  const envDir = process.env.SANDBOX_PSADT_TEMPLATE;
  const candidate = envDir && envDir.trim() ? envDir : psadtDefaultTemplateDir;
  try {
    await fsp.stat(candidate);
    return candidate;
  } catch {
    return null;
  }
}

// ---- Guide steps & auto-record -------------------------------------------
// Shared by sandbox_guide_step (manual) and the recorder (automatic). When a recording is active,
// the action tools (open/click/invoke/type/key) capture a captioned, optionally annotated step.

type ShapeInput = z.infer<typeof shapeSchema>;

const guidesDir = path.join(bridgeRoot, "guides");
const guideDirFor = (name: string) => path.join(guidesDir, name.replace(/[^a-z0-9_-]/gi, "_"));

async function readSteps(dir: string): Promise<any[]> {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, "steps.json"), "utf8"));
  } catch {
    return [];
  }
}

async function addGuideStep(opts: {
  guide: string;
  caption: string;
  window?: boolean;
  region?: number[];
  shapes?: ShapeInput[];
}): Promise<{ guide: string; step: number; image: string; totalSteps: number }> {
  const dir = guideDirFor(opts.guide);
  await fsp.mkdir(dir, { recursive: true });
  const steps = await readSteps(dir);
  const n = steps.length + 1;
  const nn = String(n).padStart(2, "0");

  const shot = await screenshot({ window: opts.window, region: opts.region });
  const rawPath = path.join(dir, `step-${nn}-raw.jpg`);
  await fsp.writeFile(rawPath, Buffer.from(shot.base64, "base64"));

  let image = `step-${nn}-raw.jpg`;
  if (opts.shapes && opts.shapes.length) {
    const outPath = path.join(dir, `step-${nn}.jpg`);
    await annotate({ inputPath: rawPath, outputPath: outPath, shapes: opts.shapes, mode: "screen", metadataPath: shot.metadataPath });
    image = `step-${nn}.jpg`;
  }

  steps.push({ n, caption: opts.caption, image });
  await fsp.writeFile(path.join(dir, "steps.json"), JSON.stringify(steps, null, 2), "utf8");
  return { guide: opts.guide, step: n, image, totalSteps: steps.length };
}

// Active auto-record session, or null. window/annotate are captured at record-start.
let activeRecording: { guide: string; window: boolean; annotate: boolean } | null = null;

// Called by action tools after a successful action. Captures a step when recording; never throws.
async function autoRecord(caption: string, shapes?: ShapeInput[]): Promise<void> {
  if (!activeRecording) return;
  try {
    await addGuideStep({
      guide: activeRecording.guide,
      caption,
      window: activeRecording.window,
      shapes: activeRecording.annotate ? shapes : undefined,
    });
  } catch (err) {
    console.error("[sandbox-pilot] auto-record step failed:", err);
  }
}

// An arrow pointing at a screen coordinate, for click/double-click auto-annotation.
function arrowAt(x: number, y: number): ShapeInput[] {
  return [{ type: "arrow", from: [x - 60, y - 60], to: [x, y] } as ShapeInput];
}

// A box around an actuated element's rect (from invoke result data), if present.
function boxFor(data: any): ShapeInput[] | undefined {
  if (Array.isArray(data?.rect) && data.rect.length === 4) {
    return [{ type: "box", rect: data.rect } as ShapeInput];
  }
  return undefined;
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
    const data = (await sendCommand("invoke", args, 30000)).data;
    if (activeRecording) {
      const label = args.name || args.automationId || "element";
      const performed = data?.action ?? args.action;
      const caption =
        performed === "setvalue" || args.value != null ? `Set "${label}" to "${args.value ?? ""}"`
        : performed === "toggle" ? `Toggle "${label}"`
        : performed === "select" ? `Select "${label}"`
        : performed === "expand" ? `Expand "${label}"`
        : performed === "collapse" ? `Collapse "${label}"`
        : `Click "${label}"`;
      await autoRecord(caption, boxFor(data));
    }
    return text(data);
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
  async ({ x, y, button }) => {
    const data = (await sendCommand("click", { x, y, button }, 30000)).data;
    await autoRecord(`${button === "left" ? "Click" : `${button}-click`} at (${x}, ${y})`, arrowAt(x, y));
    return text(data);
  },
);

server.registerTool(
  "sandbox_double_click",
  {
    title: "Double-click",
    description: "Double-click at an absolute screen coordinate (real pixels).",
    inputSchema: { x: z.number().int(), y: z.number().int() },
  },
  async ({ x, y }) => {
    const data = (await sendCommand("double_click", { x, y }, 30000)).data;
    await autoRecord(`Double-click at (${x}, ${y})`, arrowAt(x, y));
    return text(data);
  },
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
  async ({ text: t }) => {
    const data = (await sendCommand("type", { text: t }, 30000)).data;
    await autoRecord(`Type "${t}"`);
    return text(data);
  },
);

server.registerTool(
  "sandbox_key",
  {
    title: "Send special keys",
    description: "Send keystrokes in SendKeys syntax, e.g. {ENTER}, {ESC}, {TAB}, ^a (Ctrl+A), %{F4} (Alt+F4).",
    inputSchema: { keys: z.string().describe("SendKeys syntax.") },
  },
  async ({ keys }) => {
    const data = (await sendCommand("key", { keys }, 30000)).data;
    await autoRecord(`Press ${keys}`);
    return text(data);
  },
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
  async ({ target }) => {
    const data = (await sendCommand("open", { target }, 30000)).data;
    await autoRecord(`Open ${target}`);
    return text(data);
  },
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
  "sandbox_run_ps_stream",
  {
    title: "Run PowerShell in the Sandbox with live progress",
    description:
      "Run a long PowerShell command as a background job and stream its stdout to the client via MCP " +
      "progress notifications, so the call shows live movement instead of a frozen wait — and the " +
      "agent's command loop stays free meanwhile. Honors client cancellation (stops the job) and an " +
      "overall timeout. Use for slow scripts/installers; for quick commands use sandbox_run_ps.",
    inputSchema: {
      command: z.string().describe("PowerShell command or script to run inside the Sandbox."),
      timeoutMs: z.number().int().positive().default(600000).describe("Overall time to wait before cancelling the job."),
    },
  },
  async ({ command, timeoutMs }, extra) => {
    const { status, jobId, streamed } = await streamJob({
      startType: "job_start_ps",
      startArgs: { command, timeoutMs },
      statusType: "job_status",
      extra,
      overallTimeoutMs: timeoutMs,
      startTimeoutMs: 30000,
      startLabel: "starting job…",
    });
    return text({
      jobId,
      streamed,
      status: status.status,
      exitCode: status.exitCode ?? null,
      timedOut: status.timedOut ?? false,
      cancelled: status.cancelled ?? false,
      stdoutTail: status.stdoutTail ?? [],
      stderrTail: status.stderrTail ?? [],
    });
  },
);

server.registerTool(
  "sandbox_winget_bootstrap",
  {
    title: "Install WinGet in the Sandbox",
    description:
      "Bootstrap WinGet in a vanilla Windows Sandbox using Microsoft's Microsoft.WinGet.Client " +
      "PowerShell module and Repair-WinGetPackageManager flow. Use this when WinGet is missing; " +
      "sandbox_winget can also run it automatically with ensureAvailable=true.",
    inputSchema: {
      skipIfAvailable: z.boolean().default(true).describe("Return immediately when winget.exe already works."),
      timeoutMs: z.number().int().positive().default(300000).describe("Maximum time to wait for the bootstrap."),
    },
  },
  async ({ skipIfAvailable, timeoutMs }) =>
    text((await sendCommand("winget_bootstrap", { skipIfAvailable, timeoutMs }, timeoutMs + 30000)).data),
);

const JOB_DONE_STATES = ["completed", "timedOut", "cancelled", "unknown"];

// Generic "run a guest background job and stream its progress" engine. Starts the job (returns
// fast), then polls a status command, emitting MCP progress notifications for each new output line
// — and a numeric progress bar when the status carries one (e.g. winget's download %). The job
// runs in its own process, so the agent's command loop stays free. Survives a single poll hiccup,
// honors MCP cancellation, and enforces an overall deadline (cancelling the job on timeout).
async function streamJob(opts: {
  startType: string;
  startArgs: Record<string, any>;
  statusType: string;
  extra: any;
  overallTimeoutMs: number;
  startTimeoutMs: number;
  startLabel: string;
}): Promise<{ start: any; status: any; jobId: string; streamed: boolean }> {
  const { startType, startArgs, statusType, extra, overallTimeoutMs, startTimeoutMs, startLabel } = opts;
  const progressToken = extra?._meta?.progressToken;
  const streamed = progressToken !== undefined && progressToken !== null;
  let seq = 0;
  const emit = (message: string, numeric?: { progress: number; total: number }) => {
    if (!streamed) return;
    seq += 1;
    const params: any = { progressToken, message };
    if (numeric) {
      params.progress = numeric.progress;
      params.total = numeric.total;
    } else {
      params.progress = seq;
    }
    void extra.sendNotification({ method: "notifications/progress", params }).catch(() => {});
  };

  emit(startLabel);
  const start = (await sendCommand(startType, startArgs, startTimeoutMs)).data;
  const jobId = start.jobId;
  if (!jobId) throw new Error(`${startType} did not return a jobId`);
  if (start.source) emit(`source: ${start.source}`);

  const lineOf = (status: any): string => {
    const out = (status.output ?? "").trim();
    if (out) return out.split("\n").pop()!.trim();
    const tail = Array.isArray(status.stdoutTail) ? status.stdoutTail : [];
    for (let i = tail.length - 1; i >= 0; i--) {
      const t = String(tail[i]).trim();
      if (t) return t;
    }
    return "";
  };
  const isDone = (status: any): boolean =>
    status.done === true || (typeof status.status === "string" && JOB_DONE_STATES.includes(status.status));

  const finalize = async (): Promise<any> => {
    try {
      await sendCommand("job_cancel", { jobId }, 30000);
    } catch {
      /* best effort */
    }
    try {
      return (await sendCommand(statusType, { jobId }, 30000)).data;
    } catch {
      return null;
    }
  };

  const deadline = Date.now() + overallTimeoutMs;
  let lastLine = "";
  let status: any = null;
  for (;;) {
    try {
      status = (await sendCommand(statusType, { jobId }, 30000)).data;
      const line = lineOf(status);
      if (line && line !== lastLine) {
        lastLine = line;
        const pct = status.progress?.percent;
        // Collapse winget's noisy progress-bar line (byte fractions / repeated %) to a clean
        // "downloading N%"; leave real text lines (Downloading <url>, Starting install…) as-is.
        const isBar = /\d+(?:\.\d+)?\s*(?:B|KB|MB|GB)\s*\/|\d+\s*%/.test(line);
        const message = isBar && typeof pct === "number" ? `downloading ${pct}%` : line;
        emit(message, typeof pct === "number" ? { progress: pct, total: 100 } : undefined);
      }
      if (isDone(status)) break;
    } catch (e) {
      // A single poll hiccup must not abort the stream — the job runs in its own process.
      emit(`(status poll retry: ${(e as Error).message})`);
    }
    if (extra?.signal?.aborted) {
      emit("cancelled by client — stopping job");
      status = (await finalize()) ?? status;
      break;
    }
    if (Date.now() >= deadline) {
      status = (await finalize()) ?? status;
      break;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!status) throw new Error(`${statusType} produced no status`);
  emit(status.message ?? `finished (${status.outcome ?? status.status})`);
  return { start, status, jobId, streamed };
}

// Stream a winget install/upgrade and return the same structured shape as the synchronous path.
async function runWingetStreaming(args: Record<string, any>, extra: any): Promise<any> {
  const action = args.action;
  const overallTimeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 600000;
  const target = (args.packageId ?? args.query ?? "").toString();
  const { start, status, jobId, streamed } = await streamJob({
    startType: "winget_start",
    startArgs: args,
    statusType: "winget_status",
    extra,
    overallTimeoutMs,
    startTimeoutMs: Math.max(overallTimeoutMs, 330000) + 30000, // bootstrap can run inline in winget_start
    startLabel: `winget ${action} ${target}: starting…`.trim(),
  });
  return {
    action,
    packageId: args.packageId ?? "",
    query: args.query ?? "",
    source: start.source,
    jobId,
    streamed,
    succeeded: status.succeeded ?? false,
    outcome: status.outcome ?? status.status,
    exit: status.exit ?? null,
    message: status.message ?? null,
    output: status.output ?? "",
    winget: start.winget,
    bootstrap: start.bootstrap,
  };
}

server.registerTool(
  "sandbox_winget",
  {
    title: "Run WinGet in the Sandbox",
    description:
      "Search, show, install, upgrade, uninstall, or list software with WinGet inside the Sandbox. " +
      "Tuned for unattended Sandbox use: pins the community 'winget' source by default (so it never " +
      "reaches into 'msstore', which needs a signed-in account and pops Store/login GUIs), exact " +
      "package-id matching when a target is supplied, agreement flags, disabled interactivity, and " +
      "silent install/upgrade. The result includes an interpreted 'outcome' (success | noop | " +
      "notFound | needsInput | needsAttention | failed | timeout), the decoded winget exit code, a " +
      "human 'message', and cleaned 'output' (progress-bar noise stripped). 'noop' (e.g. already " +
      "installed, nothing to upgrade) reports succeeded=true. install/upgrade run as a background " +
      "job and stream live progress via MCP progress notifications (so the call is never a frozen " +
      "wait), without blocking other Sandbox commands. To target the Microsoft Store, set " +
      "source='msstore' explicitly (expect it to fail in a disposable Sandbox).",
    inputSchema: {
      action: z.enum(["search", "show", "install", "upgrade", "uninstall", "list"]).describe("WinGet command to run."),
      packageId: z.string().optional().describe("WinGet package id, passed with --id. Preferred for install/uninstall/upgrade. Run action=search first to find the exact id."),
      query: z.string().optional().describe("Free-text search or package query when packageId is not known."),
      exact: z
        .boolean()
        .optional()
        .describe("Add --exact. Defaults to true when packageId is supplied, false for free-text query searches."),
      source: z.string().optional().describe("Explicit WinGet source (e.g. 'winget' or 'msstore'). Overrides the default winget-source pin."),
      preferWingetSource: z
        .boolean()
        .default(true)
        .describe("When no source is given, pin --source winget for search/show/install/upgrade to avoid the flaky msstore source. Set false to let WinGet query all sources."),
      scope: z.enum(["machine", "user"]).optional().describe("Install scope, used with action=install or upgrade."),
      silent: z.boolean().default(true).describe("Add --silent for install/upgrade."),
      acceptAgreements: z.boolean().default(true).describe("Accept source/package agreements where WinGet supports it."),
      disableInteractivity: z.boolean().default(true).describe("Add --disable-interactivity."),
      customArgs: z.array(z.string()).optional().describe("Extra raw WinGet arguments appended last for advanced cases (e.g. --include-unknown, --force)."),
      timeoutMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Max time to wait. Omit/0 for an action-aware default: 600000 ms for install/upgrade/uninstall, 120000 ms for search/show/list."),
      ensureAvailable: z.boolean().default(true).describe("Bootstrap WinGet first if winget.exe is not available."),
    },
  },
  async (args, extra) => {
    // install/upgrade can be slow: run them as a streamed background job so the human sees live
    // progress and the agent's command loop never blocks. Quick actions stay synchronous.
    if (args.action === "install" || args.action === "upgrade") {
      return text(await runWingetStreaming(args as Record<string, any>, extra));
    }
    return text(
      (await sendCommand("winget", args, (args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 600000) + 30000)).data,
    );
  },
);

// Turn a snapshot diff into candidate Intune-style detection rules, best first. An MSI product
// code is the most reliable signal; otherwise the program's uninstall key (DisplayVersion, or mere
// presence) and finally a notable new executable.
function synthesizeDetectionRules(diff: any, hint?: string): any[] {
  const rules: any[] = [];
  // The diff payload caps lists as { items, truncated }; tolerate a bare array too.
  const asArr = (x: any): any[] => (Array.isArray(x) ? x : (x?.items ?? []));
  let addedPrograms: any[] = asArr(diff?.diff?.programs?.added);

  // An install often drags in runtimes (VC++ redist, .NET) — detect the APP, not its dependencies.
  // Rank: name matches the requested package first, plain apps next, redistributable runtimes last.
  const isRuntime = (p: any) => /visual c\+\+|redistributable|\bruntime\b|\.net\b|webview/i.test(p.displayName ?? "");
  const tokens = (hint ?? "")
    .toLowerCase()
    .split(/[.\s_-]+/)
    .filter((t) => t.length >= 3);
  const matchesHint = (p: any) => {
    const hay = `${p.displayName ?? ""} ${p.id ?? ""}`.toLowerCase();
    return tokens.some((t) => hay.includes(t));
  };
  if (addedPrograms.length > 1) {
    addedPrograms = [...addedPrograms].sort((a, b) => {
      const score = (p: any) => (matchesHint(p) ? 0 : 1) + (isRuntime(p) ? 2 : 0);
      return score(a) - score(b);
    });
  }
  const isMsiGuid = (s: string) => /^\{[0-9a-fA-F-]{32,38}\}$/.test(s ?? "");
  for (const p of addedPrograms) {
    if (isMsiGuid(p.id)) {
      rules.push({
        kind: "msiProductCode",
        confidence: "high",
        rule: { type: "msiProductCode", productCode: p.id, ...(p.displayVersion ? { productVersion: p.displayVersion } : {}) },
        rationale: `MSI product code for "${p.displayName ?? p.id}"${p.displayVersion ? ` v${p.displayVersion}` : ""}.`,
      });
    } else if (p.keyPath && p.displayVersion) {
      rules.push({
        kind: "registryVersion",
        confidence: "high",
        rule: { type: "registry", path: p.keyPath, valueName: "DisplayVersion", operator: "equals", value: p.displayVersion },
        rationale: `Uninstall-key DisplayVersion for "${p.displayName ?? p.id}" equals ${p.displayVersion}.`,
      });
    } else if (p.keyPath) {
      rules.push({
        kind: "registryPresence",
        confidence: "medium",
        rule: { type: "registry", path: p.keyPath },
        rationale: `Uninstall key present for "${p.displayName ?? p.id}".`,
      });
    }
  }
  if (rules.length === 0) {
    // Fall back to a notable new executable under a program-files path.
    const addedFiles: any[] = asArr(diff?.diff?.files?.added);
    const exe = addedFiles.find((f) => /\.exe$/i.test(f.path) && /program files/i.test(f.path)) ?? addedFiles.find((f) => /\.exe$/i.test(f.path));
    if (exe) {
      rules.push({
        kind: "filePresence",
        confidence: "low",
        rule: { type: "file", path: exe.path },
        rationale: `New executable installed at ${exe.path}.`,
      });
    }
  }
  if (rules.length) rules[0].recommended = true;
  return rules;
}

server.registerTool(
  "sandbox_install_and_profile",
  {
    title: "Install, profile the footprint, and synthesize a detection rule",
    description:
      "The full app-packaging loop in one call: snapshot the system, install the package with " +
      "WinGet (streaming live progress), snapshot again, diff to capture the install footprint " +
      "(new programs / registry / services, and optionally files), then synthesize candidate " +
      "Intune-style detection rules (MSI product code → uninstall-key DisplayVersion → presence → " +
      "new exe) and verify the recommended one inside the Sandbox. Returns the install result, the " +
      "footprint diff, the ranked detection rules, and the verification verdict. This is what turns " +
      "'install X' into 'here is how Intune will detect X'.",
    inputSchema: {
      packageId: z.string().optional().describe("WinGet package id (preferred). Run sandbox_winget action=search to find it."),
      query: z.string().optional().describe("Free-text package query when packageId is unknown."),
      exact: z.boolean().optional().describe("Add --exact (defaults true when packageId is given)."),
      source: z.string().optional().describe("Explicit WinGet source; defaults to the pinned 'winget' source."),
      preferWingetSource: z.boolean().default(true).describe("Pin --source winget when no source is given."),
      scope: z.enum(["machine", "user"]).optional().describe("Install scope."),
      customArgs: z.array(z.string()).optional().describe("Extra raw WinGet arguments."),
      timeoutMs: z.number().int().nonnegative().optional().describe("Install timeout; omit for the 600000 ms default."),
      includeFiles: z
        .boolean()
        .default(false)
        .describe("Also snapshot/diff files under the common install roots. Off by default because the file scan is slow; turn on for a complete footprint or a file-based detection rule."),
      verify: z.boolean().default(true).describe("Verify the recommended detection rule (expectedPresent=true) after install."),
    },
  },
  async (args, extra) => {
    const snapOpts = {
      includeFiles: args.includeFiles ?? false,
      includeRegistry: true,
      includePrograms: true,
      includeServices: true,
    };
    const before = (await sendCommand("snapshot_capture", { label: "before-install", ...snapOpts }, 300000)).data;
    const install = await runWingetStreaming(
      {
        action: "install",
        packageId: args.packageId,
        query: args.query,
        exact: args.exact,
        source: args.source,
        preferWingetSource: args.preferWingetSource,
        scope: args.scope,
        customArgs: args.customArgs,
        timeoutMs: args.timeoutMs,
      },
      extra,
    );
    const after = (await sendCommand("snapshot_capture", { label: "after-install", ...snapOpts }, 300000)).data;
    const diff = await diffSnapshots({ bridgeRoot }, before.snapshotId, after.snapshotId, new Date().toISOString());
    const detectionRules = synthesizeDetectionRules(diff, args.packageId ?? args.query);

    let verification: any = null;
    if (args.verify && detectionRules.length) {
      const recommended = detectionRules.find((r) => r.recommended) ?? detectionRules[0];
      try {
        verification = (await sendCommand("detection_verify", { rule: recommended.rule, expectedPresent: true }, 35000)).data;
      } catch (e) {
        verification = { error: (e as Error).message };
      }
    }

    return text({
      install: { succeeded: install.succeeded, outcome: install.outcome, exit: install.exit, message: install.message, source: install.source },
      // The pre-install snapshot is the clean baseline; pass it to sandbox_uninstall_and_profile
      // later as baselineSnapshotId to measure uninstall residue.
      baselineSnapshotId: before.snapshotId,
      afterSnapshotId: after.snapshotId,
      footprint: { counts: diff.counts, totalChanges: diff.totalChanges, programs: diff.diff?.programs, services: diff.diff?.services, artifacts: diff.artifacts },
      detectionRules,
      verification,
    });
  },
);

server.registerTool(
  "sandbox_uninstall_and_profile",
  {
    title: "Uninstall, then profile what was removed and what leaked",
    description:
      "The cleanup half of the packaging loop: snapshot, uninstall the package with WinGet (streaming " +
      "progress), snapshot again, and diff to show what the uninstaller REMOVED. If you pass the " +
      "baselineSnapshotId from a prior sandbox_install_and_profile, it also diffs the clean baseline " +
      "against the post-uninstall state to surface RESIDUE (files/registry/programs left behind). If " +
      "you pass the detectionRule, it verifies the app is now undetected (expectedPresent=false). Use " +
      "this to prove a clean uninstall and an honest Intune detection rule.",
    inputSchema: {
      packageId: z.string().optional().describe("WinGet package id to uninstall."),
      query: z.string().optional().describe("Free-text package query when packageId is unknown."),
      exact: z.boolean().optional().describe("Add --exact (defaults true when packageId is given)."),
      customArgs: z.array(z.string()).optional().describe("Extra raw WinGet arguments (e.g. --purge)."),
      timeoutMs: z.number().int().nonnegative().optional().describe("Uninstall timeout; omit for the 600000 ms default."),
      baselineSnapshotId: z.string().optional().describe("Clean pre-install snapshot id (from sandbox_install_and_profile) to measure residue against."),
      detectionRule: z.any().optional().describe("Detection rule to verify is now ABSENT after uninstall (expectedPresent=false)."),
      includeFiles: z.boolean().default(false).describe("Also snapshot/diff files (slower). Needed to see file-level residue."),
      verify: z.boolean().default(true).describe("Verify the detection rule reports absent after uninstall (when a rule is given)."),
    },
  },
  async (args, extra) => {
    const snapOpts = { includeFiles: args.includeFiles ?? false, includeRegistry: true, includePrograms: true, includeServices: true };
    const before = (await sendCommand("snapshot_capture", { label: "before-uninstall", ...snapOpts }, 300000)).data;
    const uninstall = await runWingetStreaming(
      {
        action: "uninstall",
        packageId: args.packageId,
        query: args.query,
        exact: args.exact,
        customArgs: args.customArgs,
        timeoutMs: args.timeoutMs,
      },
      extra,
    );
    const after = (await sendCommand("snapshot_capture", { label: "after-uninstall", ...snapOpts }, 300000)).data;

    const removed = await diffSnapshots({ bridgeRoot }, before.snapshotId, after.snapshotId, new Date().toISOString());
    let residue: any = null;
    if (args.baselineSnapshotId) {
      const r = await diffSnapshots({ bridgeRoot }, args.baselineSnapshotId, after.snapshotId, new Date().toISOString());
      // Anything present after uninstall but absent in the clean baseline = leftover residue.
      residue = { counts: r.counts, leftovers: { programs: r.diff?.programs?.added, registry: r.diff?.registry?.added, files: r.diff?.files?.added, services: r.diff?.services?.added }, artifacts: r.artifacts };
    }

    let verification: any = null;
    if (args.verify && args.detectionRule) {
      try {
        verification = (await sendCommand("detection_verify", { rule: args.detectionRule, expectedPresent: false }, 35000)).data;
      } catch (e) {
        verification = { error: (e as Error).message };
      }
    }

    return text({
      uninstall: { succeeded: uninstall.succeeded, outcome: uninstall.outcome, exit: uninstall.exit, message: uninstall.message },
      removed: { counts: removed.counts, programs: removed.diff?.programs, registry: removed.diff?.registry, services: removed.diff?.services, artifacts: removed.artifacts },
      residue,
      verification,
    });
  },
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
      collectEventLogs: z
        .boolean()
        .default(true)
        .describe("Collect Application/System event-log entries (Critical/Error/Warning + MsiInstaller) around the install window for failure diagnostics."),
      eventLogMaxEvents: z.number().int().positive().default(200).describe("Cap on collected event-log entries."),
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
  "sandbox_event_logs",
  {
    title: "Collect Windows Event Log entries",
    description:
      "Read Windows Event Log entries from the Application/System channels in a time window — for " +
      "diagnosing an install/uninstall failure after the fact. Keeps Critical/Error/Warning levels " +
      "plus MsiInstaller result events, trims messages, and caps the count. Specify the window with " +
      "lastMinutes (default 5) or explicit startTime/endTime (ISO 8601).",
    inputSchema: {
      lastMinutes: z.number().int().positive().default(5).describe("Look back this many minutes from now (ignored if startTime is given)."),
      startTime: z.string().optional().describe("ISO 8601 window start; overrides lastMinutes."),
      endTime: z.string().optional().describe("ISO 8601 window end; defaults to now."),
      logNames: z.array(z.string()).optional().describe("Channels to read (default Application, System)."),
      levels: z.array(z.number().int()).optional().describe("Event levels to keep: 1=Critical, 2=Error, 3=Warning, 4=Information (default 1,2,3)."),
      maxEvents: z.number().int().positive().default(200).describe("Cap on returned entries."),
    },
  },
  async (args) => text((await sendCommand("event_logs", args, 60000)).data),
);

// Cursor into the guest's watcher event buffer, so sandbox_watch_poll returns only what's new and
// sandbox_wait_for_event baselines to "now". Reset whenever the watcher (re)starts.
let lastWatchCursor = -1;

server.registerTool(
  "sandbox_watch_start",
  {
    title: "Start the real-time screen watcher",
    description:
      "Start a background watcher inside the Sandbox that continuously (every intervalMs) notices " +
      "top-level windows opening/closing, the foreground window changing, processes starting/exiting, " +
      "programs being installed/removed (uninstall registry), and files appearing/disappearing in the " +
      "watched dirs — without the agent having to take screenshots. The agent auto-starts this at boot; " +
      "call this only to reconfigure it. Drain events with sandbox_watch_poll or block on one with " +
      "sandbox_wait_for_event. This is how you catch a dialog (e.g. a modal installer box) the moment " +
      "it appears.",
    inputSchema: {
      intervalMs: z.number().int().positive().default(300).describe("Window/process diff cadence in ms (lower = snappier, more CPU)."),
      watchProcesses: z.boolean().default(true).describe("Emit processStarted/processExited events (by process name)."),
      watchForeground: z.boolean().default(true).describe("Emit foregroundChanged events."),
      watchPrograms: z.boolean().default(true).describe("Emit programInstalled/programRemoved events (uninstall registry diff)."),
      watchFiles: z.boolean().default(true).describe("Emit fileCreated/fileRemoved/fileRenamed events for the watched dirs."),
      useFsWatcher: z.boolean().default(true).describe("Use a real-time recursive FileSystemWatcher for file events (vs a shallow poll fallback)."),
      watchServices: z.boolean().default(true).describe("Emit serviceInstalled/serviceRemoved/serviceStateChanged events."),
      watchScheduledTasks: z.boolean().default(true).describe("Emit scheduledTaskAdded/scheduledTaskRemoved events."),
      watchRunKeys: z.boolean().default(true).describe("Emit autorunAdded/autorunRemoved/autorunChanged events (Run/RunOnce keys)."),
      scanEveryTicks: z.number().int().positive().default(5).describe("Run the heavier program/service/task/registry scans every Nth interval (throttle)."),
      watchDirs: z.array(z.string()).optional().describe("Dirs to watch for file events (recursive). Defaults to the user's Downloads, Desktop, and Public Desktop."),
    },
  },
  async (args) => {
    const r = (await sendCommand("watch_start", args, 15000)).data;
    lastWatchCursor = typeof r?.cursor === "number" ? r.cursor : -1;
    return text(r);
  },
);

server.registerTool(
  "sandbox_watch_stop",
  {
    title: "Stop the screen watcher",
    description: "Stop the background watcher and tear down its runspace. Returns its final status.",
    inputSchema: {},
  },
  async () => text((await sendCommand("watch_stop", {}, 15000)).data),
);

server.registerTool(
  "sandbox_watch_poll",
  {
    title: "Drain new watcher events",
    description:
      "Return the watcher events that occurred since the last poll (windowOpened / windowClosed / " +
      "foregroundChanged / processStarted / processExited / programInstalled / programRemoved / " +
      "fileCreated / fileRemoved, each with a timestamp). Cheap — no screenshot. Auto-starts the " +
      "watcher if it isn't running. Use between actions to learn what changed; use " +
      "sandbox_wait_for_event to block for one.",
    inputSchema: {
      max: z.number().int().positive().default(500).describe("Max events to return."),
    },
  },
  async ({ max }) => {
    const r = (await sendCommand("watch_poll", { sinceId: lastWatchCursor, max }, 15000)).data;
    if (typeof r?.cursor === "number") lastWatchCursor = r.cursor;
    return text(r);
  },
);

server.registerTool(
  "sandbox_wait_for_event",
  {
    title: "Block until something happens across the system",
    description:
      "Block until the watcher reports a NEW event (from the moment of this call) matching the filter, " +
      "or until timeout — then return it plus everything else seen meanwhile. THIS IS HOW YOU REPLACE " +
      "'sleep N seconds and hope': name what you're waiting for and get control back the instant it " +
      "happens. Match any of several event types and/or a regex (or substring) over the event value. " +
      "Examples: wait for types=['programInstalled'] regex='Acrobat' after an install; " +
      "types=['windowOpened'] regex='(?i)error|user account control' to catch a blocking dialog; " +
      "types=['processExited'] contains='setup' for an installer to finish. satisfied=false means it " +
      "timed out (check the returned events to see what did happen).",
    inputSchema: {
      timeoutMs: z.number().int().positive().default(30000).describe("Max time to block, in ms."),
      pollMs: z.number().int().positive().default(200).describe("Internal poll cadence in ms."),
      types: z
        .array(
          z.enum([
            "windowOpened",
            "windowClosed",
            "foregroundChanged",
            "processStarted",
            "processExited",
            "programInstalled",
            "programRemoved",
            "fileCreated",
            "fileRemoved",
            "fileRenamed",
            "serviceInstalled",
            "serviceRemoved",
            "serviceStateChanged",
            "scheduledTaskAdded",
            "scheduledTaskRemoved",
            "autorunAdded",
            "autorunRemoved",
            "autorunChanged",
          ]),
        )
        .optional()
        .describe("Match any of these event types (omit to match any type)."),
      type: z.string().optional().describe("Convenience: a single event type (merged into types)."),
      contains: z.string().optional().describe("Match when the event value contains this substring (case-insensitive)."),
      regex: z.string().optional().describe("Match when the event value matches this regex (case-insensitive). Takes precedence over contains for fine filters."),
      sinceId: z
        .number()
        .int()
        .optional()
        .describe(
          "Only consider events after this cursor id. Omit to match from now. To wait race-free for the effect of an action you're about to take: read the cursor from sandbox_watch_poll FIRST, trigger the action, then pass that cursor here.",
        ),
    },
  },
  async (args) => {
    const types = [...(args.types ?? []), ...(args.type ? [args.type] : [])];
    const r = (
      await sendCommand(
        "wait_for_event",
        { timeoutMs: args.timeoutMs, pollMs: args.pollMs, types, contains: args.contains, regex: args.regex, sinceId: args.sinceId ?? -1 },
        (args.timeoutMs ?? 30000) + 5000,
      )
    ).data;
    if (typeof r?.cursor === "number") lastWatchCursor = r.cursor;
    return text(r);
  },
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
  collectEventLogs: z.boolean().optional().describe("Collect Application/System event logs around this step's 'run' for failure diagnostics (rendered in summary.md on failure)."),
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
  "sandbox_test_phishing_url",
  {
    title: "Test URL/email for phishing indicators",
    description:
      "Analyze a user-supplied URL or a whole email for phishing indicators inside the disposable Sandbox. " +
      "The tool extracts http/https links from raw text, HTML, or EML content; scores static email/URL signals " +
      "(mismatched link text, shorteners, punycode, IP hosts, suspicious payloads, non-HTTPS, long/encoded URLs); " +
      "runs background DNS/TLS/HTTP/redirect checks from inside the Sandbox; then opens the selected target in " +
      "Microsoft Edge InPrivate and captures foreground UI evidence. It writes a Markdown report and results.json " +
      "under bridge\\artifacts\\phishing-url-tests. Default foreground behavior opens the highest-risk extracted URL.",
    inputSchema: {
      url: z.string().optional().describe("A single URL to test directly."),
      emailText: z.string().optional().describe("Raw email source, rendered email text, or HTML body to extract URLs from."),
      emailHostPath: z.string().optional().describe("Host path to an .eml/.html/.txt email artifact to read and analyze."),
      emailGuestPath: z.string().optional().describe("Guest path inside the Sandbox to an email artifact to read and analyze."),
      maxUrls: z.number().int().min(1).max(50).default(10).describe("Maximum extracted URLs to analyze."),
      foregroundMode: z
        .enum(["none", "first", "highestRisk", "all"])
        .default("highestRisk")
        .describe("Which URL(s) to open in Edge after background checks."),
      waitMs: z.number().int().min(1000).max(60000).default(8000).describe("Milliseconds to wait after opening Edge before collecting foreground evidence."),
      captureScreenshot: z.boolean().default(true).describe("Capture a foreground Edge screenshot for the report."),
      timeoutMs: z.number().int().min(5000).max(120000).default(30000).describe("Timeout for each background PowerShell URL check."),
    },
  },
  async (args) =>
    text(
      await runEmailUrlPhishingTest(
        { sendCommand, screenshot, bridgeRoot },
        args,
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
  "sandbox_test_intune_deployment",
  {
    title: "Test an Intune-style deployment",
    description:
      "Simulate the Intune Management Extension packaging run as closely as a disposable Sandbox allows: " +
      "copy the source into an isolated IME-like content cache, run the install command from that working " +
      "directory as SYSTEM or the sandbox user, choose x64/x86 PowerShell, collect event logs and blocking " +
      "UI evidence, verify detection after install, run uninstall, verify detection is absent, and return " +
      "one pass/fail verdict. With buildDossier=true it also writes a Markdown/JSON packaging dossier.",
    inputSchema: {
      sourceHostFolder: z.string().optional().describe("Host folder containing the app source. Preferred for normal use; it is staged into the Sandbox first."),
      sourceFolder: z.string().optional().describe("Guest-visible source folder. Use C:\\SandboxBridge\\... paths, not host-only paths."),
      setupFile: z.string().optional().describe("Optional setup file name for dossier metadata."),
      appName: z.string().optional().describe("Friendly app name for the dossier and artifact folder."),
      installCommand: z.string().describe("Intune install command, run from the staged content folder."),
      uninstallCommand: z.string().optional().describe("Intune uninstall command, run from the staged content folder."),
      detectionRule: z.any().optional().describe("Intune-style detection rule to verify after install and uninstall."),
      installContext: z.enum(["system", "adminUser", "currentUser", "user"]).default("system").describe("Execution context to test. Intune Win32 apps usually run as system."),
      architecture: z.enum(["x64", "x86"]).default("x64").describe("PowerShell host architecture for the command wrapper."),
      installTimeoutMs: z.number().int().positive().default(1800000).describe("Install timeout, default 30 minutes."),
      uninstallTimeoutMs: z.number().int().positive().default(900000).describe("Uninstall timeout, default 15 minutes."),
      expectedInstallExitCodes: z.array(z.number().int()).default([0, 1707, 3010, 1641]).describe("Exit codes Intune should treat as successful for install."),
      expectedUninstallExitCodes: z.array(z.number().int()).default([0, 1605, 1707, 3010, 1641]).describe("Exit codes Intune should treat as successful for uninstall."),
      verifyDetection: z.boolean().default(true).describe("Verify detection after install and expected absence after uninstall."),
      testUninstall: z.boolean().default(true).describe("Run uninstall after a successful install."),
      collectEventLogs: z.boolean().default(true).describe("Collect Application/System event logs around install and uninstall."),
      includeSnapshots: z.boolean().default(true).describe("Capture before/after snapshots and attach install footprint/residue diffs."),
      includeFiles: z.boolean().default(false).describe("Include file scans in snapshots. Slower, but useful for file-based detection and residue."),
      destinationName: z.string().optional().describe("Optional staging folder name under bridge\\processed when sourceHostFolder is used."),
      buildDossier: z.boolean().default(true).describe("Write a Markdown/JSON packaging dossier from the test evidence."),
    },
  },
  async (args) => {
    if (!args.sourceHostFolder && !args.sourceFolder) throw new Error("Provide sourceHostFolder or sourceFolder.");
    let staged: any = null;
    let sourceFolder = args.sourceFolder;
    if (args.sourceHostFolder) {
      staged = await stageHostPath({
        hostPath: args.sourceHostFolder,
        destinationName: args.destinationName,
        overwrite: true,
      });
      sourceFolder = staged.guestPath;
    } else {
      await assertNoHostOnlyGuestPath(sourceFolder, "sourceFolder");
    }

    const deployment = addBridgeHostPaths(
      (
        await sendCommand(
          "intune_ime_simulate",
          {
            sourceFolder,
            installCommand: args.installCommand,
            uninstallCommand: args.uninstallCommand,
            detectionRule: args.detectionRule,
            installContext: args.installContext,
            architecture: args.architecture,
            installTimeoutMs: args.installTimeoutMs,
            uninstallTimeoutMs: args.uninstallTimeoutMs,
            expectedInstallExitCodes: args.expectedInstallExitCodes,
            expectedUninstallExitCodes: args.expectedUninstallExitCodes,
            verifyDetection: args.verifyDetection,
            testUninstall: args.testUninstall,
            collectEventLogs: args.collectEventLogs,
            includeSnapshots: args.includeSnapshots,
            includeFiles: args.includeFiles,
          },
          (args.installTimeoutMs ?? 1800000) + (args.uninstallTimeoutMs ?? 900000) + 420000,
        )
      ).data,
    );

    let footprint: any = null;
    let residue: any = null;
    const beforeId = deployment?.snapshots?.beforeInstall?.snapshotId;
    const afterInstallId = deployment?.snapshots?.afterInstall?.snapshotId;
    const afterUninstallId = deployment?.snapshots?.afterUninstall?.snapshotId;
    if (beforeId && afterInstallId) {
      footprint = await diffSnapshots({ bridgeRoot }, beforeId, afterInstallId, new Date().toISOString());
    }
    if (beforeId && afterUninstallId) {
      residue = await diffSnapshots({ bridgeRoot }, beforeId, afterUninstallId, new Date().toISOString());
    }

    const dossier = args.buildDossier
      ? await buildPackagingDossier({
          bridgeRoot,
          appName: args.appName ?? args.setupFile ?? path.basename(args.sourceHostFolder ?? sourceFolder ?? "Intune package"),
          sourceHostFolder: args.sourceHostFolder ?? staged?.hostPath,
          setupFile: args.setupFile,
          installCommand: args.installCommand,
          uninstallCommand: args.uninstallCommand,
          detectionRule: args.detectionRule,
          deployment,
          footprint,
          residue,
          notes: ["IME simulation runs inside Windows Sandbox; use a real Intune pilot for final tenant validation."],
        })
      : null;

    return text({ stagedSource: staged, deployment, footprint, residue, dossier });
  },
);

server.registerTool(
  "sandbox_build_packaging_dossier",
  {
    title: "Build an Intune packaging dossier",
    description:
      "Create a Markdown and JSON handoff dossier from packaging evidence: install/uninstall commands, " +
      "detection rule, IME simulation result, package result, footprint and residue diffs, source hashes, " +
      "warnings, and artifact paths. Use after sandbox_test_intune_deployment or sandbox_intune_package_win32.",
    inputSchema: {
      appName: z.string().optional(),
      sourceHostFolder: z.string().optional().describe("Optional host source folder to hash into a source manifest."),
      setupFile: z.string().optional(),
      installCommand: z.string().optional(),
      uninstallCommand: z.string().optional(),
      detectionRule: z.any().optional(),
      deploymentResult: z.any().optional().describe("Result object returned as deployment by sandbox_test_intune_deployment."),
      packagingResult: z.any().optional().describe("Packaging result from sandbox_intune_package_win32 or sandbox_intune_package_from_host.packaging."),
      footprint: z.any().optional().describe("Snapshot diff result for install footprint."),
      residue: z.any().optional().describe("Snapshot diff result for uninstall residue."),
      notes: z.array(z.string()).optional(),
    },
  },
  async (args) =>
    text(
      await buildPackagingDossier({
        bridgeRoot,
        appName: args.appName,
        sourceHostFolder: args.sourceHostFolder,
        setupFile: args.setupFile,
        installCommand: args.installCommand,
        uninstallCommand: args.uninstallCommand,
        detectionRule: args.detectionRule,
        deployment: args.deploymentResult,
        packaging: args.packagingResult,
        footprint: args.footprint,
        residue: args.residue,
        notes: args.notes,
      }),
    ),
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
  "sandbox_psadt_prereqs",
  {
    title: "Resolve the PSAppDeployToolkit template",
    description:
      "Check for a cached PSAppDeployToolkit (PSADT) template in the Sandbox shared tools folder and, with " +
      "ensureTool=true, download it from the official PSAppDeployToolkit GitHub release. Defaults to the v4 " +
      "template at version 4.1.8. Downloads are pinned to the PSAppDeployToolkit/PSAppDeployToolkit release assets.",
    inputSchema: {
      version: z.string().default(PSADT_DEFAULT_VERSION).describe("PSADT release version, e.g. 4.1.8."),
      frontend: z.enum(["v4", "v3"]).default("v4").describe("Template frontend: v4 (Invoke-AppDeployToolkit.ps1) or v3 (Deploy-Application.ps1)."),
      ensureTool: z.boolean().default(true).describe("Download the template if it is not already cached."),
      downloadUrl: z
        .string()
        .optional()
        .describe("Optional override; must be a PSAppDeployToolkit GitHub release asset URL."),
    },
  },
  async ({ version, frontend, ensureTool, downloadUrl }) =>
    text(addBridgeHostPaths((await sendCommand("psadt_prereqs", { version, frontend, ensureTool, downloadUrl }, 180000)).data)),
);

server.registerTool(
  "sandbox_psadt_build",
  {
    title: "Build a PSADT deployment package",
    description:
      "Fetch the PSAppDeployToolkit (PSADT) template, scaffold a deployment package, copy a host installer folder " +
      "into Files\\, set app metadata, and inject install/uninstall commands (inferred from setupFile when not given). " +
      "Optionally overlays a company branding template (logos/banners/config), test-installs the package in the Sandbox, " +
      "and wraps it into a .intunewin. The branding template resolves from templateHostFolder, else the " +
      "SANDBOX_PSADT_TEMPLATE env var, else the bundled default skeleton.",
    inputSchema: {
      appName: z.string().describe("Application name."),
      appVersion: z.string().default("1.0.0").describe("Application version."),
      appVendor: z.string().optional().describe("Application vendor/publisher."),
      appArch: z.string().default("x64").describe("Application architecture (x64 / x86)."),
      appLang: z.string().default("EN").describe("Application language code."),
      sourceHostFolder: z.string().describe("Host folder containing the installer payload to copy into Files\\."),
      setupFile: z.string().optional().describe("Setup file inside sourceHostFolder (filename); drives install-command inference."),
      installCommand: z.string().optional().describe("Override the PSADT install task line (e.g. a Start-ADTProcess/Start-ADTMsiProcess call)."),
      uninstallCommand: z.string().optional().describe("Override the PSADT uninstall task line."),
      frontend: z.enum(["v4", "v3"]).default("v4").describe("PSADT template frontend."),
      psadtVersion: z.string().default(PSADT_DEFAULT_VERSION).describe("PSADT release version to use."),
      downloadUrl: z.string().optional().describe("Optional PSADT GitHub release asset URL override."),
      useCompanyTemplate: z.boolean().default(true).describe("Overlay the company branding template (env default or bundled skeleton) when templateHostFolder is not given."),
      templateHostFolder: z.string().optional().describe("Explicit host folder of branding/config files to overlay onto the package."),
      detectionRule: z.any().optional().describe("Optional detection rule used during test-install verification and .intunewin packaging."),
      testInstall: z.boolean().default(true).describe("Install (and uninstall) the built PSADT package inside the Sandbox to prove it works."),
      testUninstall: z.boolean().default(true).describe("Also run the PSADT uninstall during the test."),
      packageIntunewin: z.boolean().default(false).describe("Wrap the built package into a .intunewin (setupFile=Invoke-AppDeployToolkit.exe)."),
      outputHostFolder: z.string().optional().describe("Optional host folder to copy the final .intunewin package(s) into."),
      timeoutMs: z.number().int().positive().default(300000).describe("Build/download timeout in milliseconds."),
      installTestTimeoutMs: z.number().int().positive().default(180000).describe("Per-step install/uninstall test timeout in milliseconds."),
    },
  },
  async (args) => {
    // Stage the installer payload into the bridge so the Sandbox can see it.
    const stagedSource = await stageHostPath({ hostPath: args.sourceHostFolder, overwrite: true });

    // Resolve and stage the company branding template, if any.
    const templateHostFolder = await resolvePsadtTemplateHostFolder(args.templateHostFolder, args.useCompanyTemplate);
    let stagedTemplate: any = null;
    if (templateHostFolder) {
      stagedTemplate = await stageHostPath({
        hostPath: templateHostFolder,
        destinationName: "psadt-template",
        overwrite: true,
      });
    }

    const build = addBridgeHostPaths(
      (
        await sendCommand(
          "psadt_build",
          {
            appName: args.appName,
            appVersion: args.appVersion,
            appVendor: args.appVendor ?? "",
            appArch: args.appArch,
            appLang: args.appLang,
            sourceFolder: stagedSource.guestPath,
            setupFile: args.setupFile ?? "",
            installCommand: args.installCommand ?? "",
            uninstallCommand: args.uninstallCommand ?? "",
            frontend: args.frontend,
            version: args.psadtVersion,
            downloadUrl: args.downloadUrl ?? "",
            templateFolder: stagedTemplate?.guestPath ?? "",
          },
          Math.max(args.timeoutMs ?? 300000, 1000) + 30000,
        )
      ).data,
    );

    const packageGuestFolder: string | undefined = build?.packageFolder;
    const setupFile: string = build?.setupFile ?? "Invoke-AppDeployToolkit.exe";
    const installCommand: string = build?.intuneInstallCommand ?? `${setupFile} -DeploymentType Install -DeployMode Silent`;
    const uninstallCommand: string = build?.intuneUninstallCommand ?? `${setupFile} -DeploymentType Uninstall -DeployMode Silent`;

    let intunePackaging: any = null;
    let copiedPackages: any[] = [];
    let installTest: any = null;
    let uninstallTest: any = null;

    if (packageGuestFolder && args.packageIntunewin) {
      // Reuse the proven Intune path: it test-installs (per testInstall) and produces the .intunewin.
      intunePackaging = addBridgeHostPaths(
        (
          await sendCommand(
            "intune_package",
            {
              sourceFolder: packageGuestFolder,
              setupFile,
              installCommand,
              uninstallCommand,
              detectionRule: args.detectionRule,
              testInstall: args.testInstall,
              installTestTimeoutMs: args.installTestTimeoutMs,
              verifyDetection: !!args.detectionRule,
              testUninstall: args.testUninstall,
              uninstallTestTimeoutMs: args.installTestTimeoutMs,
              ensureTool: true,
              timeoutMs: args.timeoutMs,
            },
            Math.max(args.timeoutMs ?? 300000, args.installTestTimeoutMs ?? 180000, 1000) + 30000,
          )
        ).data,
      );
      if (args.outputHostFolder && intunePackaging?.packages?.length) {
        copiedPackages = await copyPackagesToHostFolder(intunePackaging.packages, args.outputHostFolder);
      }
    } else if (packageGuestFolder && args.testInstall) {
      // Standalone test-install (no .intunewin): run the PSADT launcher from the package folder.
      const exePath = `${packageGuestFolder}\\${setupFile}`;
      installTest = (
        await sendCommand(
          "installer_test",
          {
            command: `& '${exePath}' -DeploymentType Install -DeployMode Silent`,
            workingDirectory: packageGuestFolder,
            timeoutMs: args.installTestTimeoutMs,
          },
          Math.max(args.installTestTimeoutMs ?? 180000, 1000) + 30000,
        )
      ).data;
      if (args.testUninstall) {
        uninstallTest = (
          await sendCommand(
            "installer_test",
            {
              command: `& '${exePath}' -DeploymentType Uninstall -DeployMode Silent`,
              workingDirectory: packageGuestFolder,
              timeoutMs: args.installTestTimeoutMs,
            },
            Math.max(args.installTestTimeoutMs ?? 180000, 1000) + 30000,
          )
        ).data;
      }
    }

    return text({
      stagedSource,
      stagedTemplate,
      brandingTemplateHostFolder: templateHostFolder,
      build,
      installTest,
      uninstallTest,
      intunePackaging,
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
      "the foreground window name, and a compatibility block comparing the guest agent version/" +
      "protocol against this server's. A mismatch (warning set) means the agent in the Sandbox is " +
      "stale — redeploy it with `host\\SandboxBridge.ps1 reload-agent`.",
    inputSchema: {},
  },
  async () => {
    const data = (await sendCommand("health", {}, 10000)).data ?? {};
    const guestProtocol = typeof data.protocol === "number" ? data.protocol : null;
    const compatible = guestProtocol === EXPECTED_GUEST_PROTOCOL;
    const versionMatch = (data.version ?? null) === SERVER_VERSION;
    const compatibility = {
      serverVersion: SERVER_VERSION,
      serverProtocol: EXPECTED_GUEST_PROTOCOL,
      guestVersion: data.version ?? null,
      guestProtocol,
      compatible,
      versionMatch,
      warning: !compatible
        ? guestProtocol === null
          ? "Guest agent did not report a protocol version — it predates the handshake. Redeploy with reload-agent."
          : `Guest agent protocol ${guestProtocol} != server ${EXPECTED_GUEST_PROTOCOL}. The agent is stale; redeploy with reload-agent.`
        : versionMatch
          ? null
          : `Guest agent version ${data.version ?? "?"} != server ${SERVER_VERSION} (protocol still compatible). Redeploy with reload-agent to pick up the newest agent.`,
    };
    return text({ ...data, compatibility });
  },
);

server.registerTool(
  "sandbox_cleanup",
  {
    title: "Prune old run artifacts",
    description:
      "Delete old artifacts the server accumulates in the shared bridge — job logs, test-plan runs, " +
      "snapshots, snapshot diffs, and screenshots (and optionally recorded guides). Each area keeps " +
      "the newest `keepLast` entries; beyond that it removes entries older than `maxAgeDays` (or all of " +
      "them if `maxAgeDays` is omitted). Use `dryRun` to preview. Works even when the Sandbox agent is " +
      "not running, since the bridge is a host folder.",
    inputSchema: {
      maxAgeDays: z.number().positive().optional().describe("Only delete entries older than this many days (omit to delete everything beyond keepLast)."),
      keepLast: z.number().int().min(0).default(20).describe("Always keep this many newest entries per area."),
      includeGuides: z.boolean().default(false).describe("Also prune recorded guides under bridge/guides (off by default — guides are deliverables)."),
      areas: z
        .array(z.enum(["jobs", "testplans", "snapshots", "snapshotDiffs", "screenshots", "guides"]))
        .optional()
        .describe("Restrict cleanup to these areas (default: all except guides)."),
      dryRun: z.boolean().default(false).describe("Report what would be removed without deleting."),
    },
  },
  async (args) => text(await cleanupArtifacts({ bridgeRoot }, args, Date.now())),
);

// ---- Annotation ----------------------------------------------------------

const shapeSchema = z
  .object({
    type: z.enum(["box", "arrow", "label", "spotlight", "redact"]),
    rect: z.array(z.number()).length(4).optional().describe("[x,y,w,h] for box/spotlight/redact."),
    pixelate: z.boolean().optional().describe("redact: pixelate the region instead of a solid fill."),
    blocks: z.number().optional().describe("redact+pixelate: horizontal block count (coarseness; default 8)."),
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
      "Draw boxes / arrows / labels / spotlight / redact onto a previously captured screenshot and return the " +
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
// guidesDir / guideDirFor / readSteps / addGuideStep live near the top (shared with auto-record).

server.registerTool(
  "sandbox_guide_step",
  {
    title: "Record a guide step",
    description:
      "Capture a screenshot, optionally annotate it (boxes/arrows/labels/redact in real screen coords), " +
      "and append it as a numbered step with a caption to a named guide. Build the final document " +
      "with sandbox_guide_build. Use window/region to focus the shot on the relevant UI. For hands-off " +
      "capture, use sandbox_record_start to auto-append a step after every action instead.",
    inputSchema: {
      guide: z.string().describe("Guide name (a folder under bridge/guides)."),
      caption: z.string().describe("Instruction text shown above this step's screenshot."),
      window: z.boolean().optional().describe("Capture only the foreground window."),
      region: z.array(z.number()).length(4).optional().describe("[x,y,w,h] real-screen crop."),
      shapes: z.array(shapeSchema).optional().describe("Optional annotations (screen-coord boxes/arrows/labels/redact)."),
    },
  },
  async ({ guide, caption, window, region, shapes }) => text(await addGuideStep({ guide, caption, window, region, shapes })),
);

server.registerTool(
  "sandbox_record_start",
  {
    title: "Start auto-recording a guide",
    description:
      "Begin capturing a guide automatically: after this, each action (sandbox_open / _click / " +
      "_double_click / _invoke / _type / _key) appends a captioned screenshot step to the named guide, " +
      "with the caption derived from the action and (by default) an annotation marking the target. Drive " +
      "the task once and get the walkthrough for free. Call sandbox_record_stop when done, then " +
      "sandbox_guide_build. Only one recording is active at a time.",
    inputSchema: {
      guide: z.string().describe("Guide name to append auto-captured steps to."),
      window: z.boolean().default(false).describe("Capture only the foreground window for each step."),
      annotate: z.boolean().default(true).describe("Draw an arrow/box on the action target in each captured step."),
    },
  },
  async ({ guide, window, annotate: annotateOn }) => {
    activeRecording = { guide, window, annotate: annotateOn };
    return text({ recording: true, guide, window, annotate: annotateOn });
  },
);

server.registerTool(
  "sandbox_record_stop",
  {
    title: "Stop auto-recording",
    description: "Stop the active guide recording. Returns the guide name and how many steps it now has. Build the document with sandbox_guide_build.",
    inputSchema: {},
  },
  async () => {
    if (!activeRecording) return text({ recording: false, message: "No recording was active." });
    const guide = activeRecording.guide;
    activeRecording = null;
    const steps = await readSteps(guideDirFor(guide));
    return text({ recording: false, guide, totalSteps: steps.length });
  },
);

server.registerTool(
  "sandbox_guide_build",
  {
    title: "Build the guide document",
    description:
      "Assemble the recorded steps of a named guide into one or more documents with embedded screenshots: " +
      "Markdown (default), self-contained HTML (base64-embedded images), and/or PDF. Returns the host path " +
      "of each generated file.",
    inputSchema: {
      guide: z.string(),
      title: z.string().optional().describe("Document title (defaults to the guide name)."),
      formats: z
        .array(z.enum(["markdown", "html", "pdf"]))
        .optional()
        .describe("Output formats to produce (default ['markdown'])."),
    },
  },
  async ({ guide, title, formats }) => {
    const dir = guideDirFor(guide);
    const steps = await readSteps(dir);
    if (!steps.length) throw new Error(`No steps recorded for guide '${guide}'. Use sandbox_guide_step or sandbox_record_start first.`);
    const outputs = await buildGuideDocs({ title: title ?? guide, steps: steps as any, dir, formats: formats ?? ["markdown"] });
    return text({ guide, steps: steps.length, outputs });
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
