# windows-sandbox-mcp

An MCP server (TypeScript/Node) that drives a Windows Sandbox through the host/guest
bridge: screenshots (inline), the UI Automation tree, mouse/keyboard input, PowerShell, and
screenshot annotation.

It supports two transports (see **Transports** below) and shells out to
`host/SandboxBridge.ps1` only for Sandbox lifecycle.

## Build

```powershell
npm install   # builds automatically via the "prepare" script (runs tsc)
```

Or use the repo-root helper, which also prints your MCP client config: `..\setup.ps1`.

## Tools

| Tool | Purpose |
|---|---|
| `sandbox_health` | Liveness probe: agent responds, transport, pid, screen size, headless flag, foreground window. |
| `sandbox_status` | List running Sandboxes (wsb). |
| `sandbox_prepare` | One call: start/reuse a Sandbox, open the interactive session, pin a clean 1920×1080 resolution, set DNS, and start the control agent (socket agent + wait for its endpoint when `SANDBOX_TRANSPORT=socket`). Reuses a running Sandbox by default; pass `fresh=true` to destroy it first and boot clean. |
| `sandbox_stop` | Destroy the Sandbox VM — a real reset that wipes all guest state (omit `id` to stop all). `wsb` runs the VM detached, so closing the window only closes the viewer; the VM persists until stopped here. |
| `sandbox_set_resolution` | Resize the guest desktop to a deterministic resolution (default 1920×1080). `sandbox_prepare` applies this automatically; call it if `sandbox_health` reports a tiny/huge screen. |
| `sandbox_screenshot` | Downscaled JPEG of the full screen, a `region` [x,y,w,h], or the foreground `window`; returned inline + scale/offset metadata. (The folder auto-rotates to the most recent ~40.) |
| `sandbox_ui_tree` | UI Automation tree with real-pixel `click` points (foreground window or desktop). |
| `sandbox_invoke` | Actuate a control by name/automationId via UIA patterns (Invoke/Toggle/Select/Expand/SetValue) — no coordinates; prefers the match that supports the action; coordinate-click fallback. |
| `sandbox_wait_for` | Block until an element is present (or absent) or a timeout elapses — synchronize instead of guessing sleeps. |
| `sandbox_ocr` | Recognize on-screen text → words with real-pixel `click` points (fallback for apps `sandbox_ui_tree` can't see). Uses built-in Windows OCR if a language is installed, else the **bundled Tesseract** in `tools/tesseract` — so it works on a vanilla Sandbox offline. |
| `sandbox_click` / `sandbox_double_click` / `sandbox_type` / `sandbox_key` | Mouse click / double-click and keyboard input. |
| `sandbox_scroll` / `sandbox_drag` | Mouse-wheel scroll (ticks ± = up/down) and press-move-release drag (sliders, reorder, move windows). |
| `sandbox_open` | Launch an app / file / URI (incl. `ms-settings:` links). |
| `sandbox_run_ps` | Run PowerShell in the Sandbox, return its output. |
| `sandbox_center_window` | Center the foreground window for clean screenshots. |
| `sandbox_annotate` | Draw boxes/arrows/labels/spotlight on a screenshot (screen or image coords; screen mode is capture-offset aware, so window/region shots annotate correctly). |
| `sandbox_guide_step` / `sandbox_guide_build` / `sandbox_guide_reset` | Record captioned (optionally annotated) screenshot steps into a named guide, then assemble them into a Markdown document with embedded images. |

Sensing guidance baked into the tool descriptions: prefer `sandbox_ui_tree` for "what's on
screen / where to click" (cheap, exact coordinates); use `sandbox_screenshot` for visual
judgment. On apps that expose no UI tree (Chromium/CEF dialogs, custom-drawn UIs), fall back
to a screenshot and use `sandbox_annotate` in `image` mode.

## Client configuration

Add to your MCP client (e.g. Claude Code / Codex). The simplest is `npx` (see the top-level
README), or a local build:

```json
{
  "mcpServers": {
    "sandbox-pilot": {
      "command": "node",
      "args": ["C:/Users/you/Git/Sandbox-Pilot/dist/index.js"],
      "env": { "SANDBOX_TRANSPORT": "socket" }
    }
  }
}
```

The server resolves the bridge folder from `SANDBOX_BRIDGE_ROOT` (defaults to `../bridge`
relative to `dist/`). Set it explicitly if you relocate the server.

## Tests

Offline unit/integration tests (no Sandbox needed — both transports run against in-process
fakes; locks in the BOM-strip and NDJSON-framing/auth regressions):

```powershell
npm test
```

End-to-end smoke test against a running Sandbox (lists tools, exercises `sandbox_ui_tree` +
`sandbox_screenshot` over stdio with the official MCP client):

```powershell
$env:SANDBOX_TRANSPORT = "socket"; node smoke.mjs
```

## Reloading the agent during development

After editing `guest/SandboxAgent.ps1`, redeploy to a running Sandbox in one command:

```powershell
.\host\SandboxBridge.ps1 reload-agent
```

It copies the latest agent, waits for the shared folder to propagate it to the guest, kills
**all** agents (System scope — avoids duplicate-agent flapping over the port), starts exactly
one socket agent, waits for its endpoint, and reconnects the interactive desktop. (Editing the
PowerShell `SandboxInput` C# class is best avoided — PowerShell's Add-Type assembly cache can
load a stale type across reloads; call the existing `mouse_event` etc. instead of adding
members.)

## Transports

Set `SANDBOX_TRANSPORT` to choose how commands reach the guest.

### `socket` (recommended, low latency)

Measured steady-state round-trip **~40–50ms** (first call ~280ms incl. connect).

- The guest agent **listens** on a TCP port and opens its own inbound firewall rule (the
  Sandbox is disposable and runs as admin). The host **connects out** to it — outbound needs
  no host firewall rule and no host admin.
- The guest publishes its `{ip,port}` to `results/agent-endpoint.json` (the guest→host
  direction of the share is fast); the host reads that and connects.
- Commands/results are NDJSON; screenshots come back as base64 in the result, so the shared
  folder is off the hot path entirely.
- **Auth**: the agent publishes a random per-session token in `agent-endpoint.json`; the host
  must send it as the first line of the connection. Connections with a wrong/missing token are
  rejected (guards the listener on the Sandbox's NAT network).

Start it (the `sandbox_prepare` tool does this for you when the server runs with
`SANDBOX_TRANSPORT=socket`):

```powershell
# manual equivalent, from the project root:
.\host\SandboxBridge.ps1 prepare-socket      # reuse/start + connect + DNS + start socket agent + await endpoint
# (or just .\host\SandboxBridge.ps1 attach-socket if a prepared Sandbox is already running)
$env:SANDBOX_TRANSPORT = "socket"; node dist/index.js
```

### `file` (default, simple but slow)

Commands round-trip through the Sandbox **mapped folder**. Functionally complete, but the
host→guest direction of the share is cached (~20s observed, volume-global — faster polling
and `wsb exec` nudges do not help). Fine for non-interactive/batch use; too slow for an
interactive control loop. This is why `socket` exists.

## Measured latency (socket transport)

| Operation | Steady-state |
|---|---|
| Lightweight command (`screen_info`, `click`, `ui_tree`) | ~40–50ms |
| `sandbox_screenshot` (downscaled JPEG, inline capture) | ~0.4s (~0.9s first call) |
| First command after connect | ~0.3s (one-time TCP connect) |

The guest agent captures screenshots **in-process** (it is DPI-aware from startup), so there
is no per-screenshot child-process spawn. One-time cost per Sandbox session: the agent's
startup (~14s) — `wsb exec` spawn plus .NET assembly loading. (The firewall rule uses `netsh`
rather than the slower `New-NetFirewallRule` cmdlet.)

## OCR engines

`sandbox_ocr` tries the built-in **Windows.Media.Ocr** engine first. A vanilla Windows Sandbox
ships **no OCR recognizer language** (the data is a Windows Update Feature-on-Demand, and the
Sandbox can't reach the FOD/Store endpoints — `0x80072ee6`), so the agent falls back to a
**bundled Tesseract** at `bridge/tools/tesseract/` (auto-available in the guest because the
bridge folder is mapped). Word boxes are mapped to real screen coordinates, so each word's
`click` point feeds straight into `sandbox_click`.

The bundle is a **~174 MB runtime artifact** (mostly `libtesseract` + ICU data) — treat it like
a downloaded dependency, not committed source. Create it with one command (with a Sandbox
running — do `prepare-socket` first):

```powershell
.\host\SandboxBridge.ps1 bundle-tesseract
```

It downloads the installer on the host, installs it inside the Sandbox (elevated via
`--run-as System`, no UAC), copies the runtime into `bridge/tools/tesseract/`, and trims the
training tools. Idempotent — skips if already present. (The guest-side step is
`bridge/InstallTesseract.ps1`.)

If you instead want **native Windows OCR** (or display-language packs), that needs the matching
build-26200 **Features-on-Demand ISO** added offline via `Add-WindowsCapability -Source -LimitAccess`
(the Microsoft Store and live Windows-Update FOD download are not available inside the Sandbox).
