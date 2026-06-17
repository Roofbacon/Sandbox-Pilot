#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { annotate, runBridgeAction, bridgeRoot } from "./bridge.js";
import * as fileBridge from "./bridge.js";
import * as socketBridge from "./socket-bridge.js";

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
    description: "Launch an executable, file path, or URI (including ms-settings: deep links) inside the Sandbox.",
    inputSchema: { target: z.string().describe("Executable, file path, or URI.") },
  },
  async ({ target }) => text((await sendCommand("open", { target }, 30000)).data),
);

server.registerTool(
  "sandbox_run_ps",
  {
    title: "Run PowerShell in the Sandbox",
    description: "Run a PowerShell command inside the Sandbox and return its text output.",
    inputSchema: { command: z.string() },
  },
  async ({ command }) => text((await sendCommand("run_ps", { command }, 60000)).data),
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
      "session (full-size screenshots), apply Google DNS for internet, and start the guest control " +
      "agent. With SANDBOX_TRANSPORT=socket this starts the socket agent and waits until it has " +
      "published its endpoint (returns ready=true); otherwise it starts the file-mode agent. " +
      "Run this once before driving the UI.",
    inputSchema: {},
  },
  async () => {
    const action = process.env.SANDBOX_TRANSPORT === "socket" ? "prepare-socket" : "prepare-guide";
    return text(await runBridgeAction(action));
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
