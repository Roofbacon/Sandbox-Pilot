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
| `sandbox_health` | Liveness probe: agent responds, transport, pid, screen size, headless flag, foreground window, plus a `compatibility` block comparing the guest agent's version/protocol with the server's (warns when the agent is stale). |
| `sandbox_status` | List running Sandboxes (wsb). |
| `sandbox_cleanup` | Prune old run artifacts in the shared bridge (jobs, test-plan runs, snapshots, snapshot diffs, screenshots; guides opt-in) by `keepLast` and `maxAgeDays`; `dryRun` previews. Works without the agent running. |
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
| `sandbox_winget_bootstrap` | Install WinGet into a vanilla Sandbox using Microsoft's `Microsoft.WinGet.Client` / `Repair-WinGetPackageManager` bootstrap flow. |
| `sandbox_winget` | Run WinGet search/show/install/upgrade/uninstall/list inside the Sandbox. Pins the community `winget` source by default (msstore is opt-in), runs silent/non-interactive, applies action-aware timeouts, and returns a decoded `outcome` + exit code + cleaned output. install/upgrade run as a background job and **stream live progress** (MCP progress notifications); a client cancel stops the install. |
| `sandbox_install_and_profile` | One-shot packaging loop: snapshot → streamed install → snapshot → footprint diff → synthesize Intune-style detection rule(s) (MSI product code → uninstall-key DisplayVersion → presence → new exe; ranks the app above co-installed runtimes) → verify the recommended rule. Returns install result + footprint + ranked rules + verification verdict + the clean `baselineSnapshotId`. |
| `sandbox_uninstall_and_profile` | The cleanup half: snapshot → streamed uninstall → snapshot → diff what was removed; with a `baselineSnapshotId` it reports residue (leftovers vs the clean baseline); with a `detectionRule` it verifies the app is now absent. |
| `sandbox_run_ps_stream` | Run a long PowerShell command as a background job and stream its stdout via MCP progress notifications (honors cancellation + overall timeout). Use for slow scripts; `sandbox_run_ps` stays the synchronous quick path. |
| `sandbox_find_install_candidates` | Scan Downloads or a supplied guest path for likely installer payloads and entry points, with technology detection and ranking. |
| `sandbox_msi_inspect` | Inspect MSI Product metadata, public properties, notable reboot/config flags, and suggest a silent `msiexec /qn` command. |
| `sandbox_analyze_installers` | Analyze an installer folder or extracted vendor bundle; returns entry points, MSI metadata, script evidence, recommended commands, and notes. |
| `sandbox_test_install_command` | Run a proposed silent install command with a timeout and optional working directory, then collect exit code, windows, new installed programs, pending reboot state, log tails, and (by default) Application/System event-log entries around the install window. |
| `sandbox_event_logs` | Collect Application/System event-log entries (Critical/Error/Warning + MsiInstaller results) for a time window (`lastMinutes` or explicit `startTime`/`endTime`) for after-the-fact install diagnostics. |
| `sandbox_watch_start` / `sandbox_watch_stop` | Reconfigure/stop the background event bus: a runspace that watches windows, the foreground window, processes, installed programs, files (real-time recursive FileSystemWatcher), services, scheduled tasks, and Run-key autoruns into a capped, cursor-indexed buffer. The agent **auto-starts it at boot**, so events accrue from t0. |
| `sandbox_watch_poll` / `sandbox_wait_for_event` | Drain new events since the last poll, or block until a new event matching any of `types` and/or a `regex`/`contains` occurs (or timeout) — the event-driven replacement for blind sleeps. Event types: windowOpened/Closed, foregroundChanged, processStarted/Exited, programInstalled/Removed, fileCreated/Removed/Renamed, serviceInstalled/Removed/StateChanged, scheduledTaskAdded/Removed, autorunAdded/Removed/Changed. For race-free waits on an action you trigger, read the cursor from `sandbox_watch_poll` first and pass it as `sinceId`. |
| `sandbox_verify_detection_rule` | Verify MSI product-code, registry, file/version, or PowerShell script detection rules inside the Sandbox, for expected-present or expected-absent states. |
| `sandbox_assert` | Evaluate one or more pass/fail assertions (file, registry, msiProductCode, script, process, service, window, installedProgram) honoring `expectedPresent`, and return a normalized roll-up. |
| `sandbox_run_test_plan` | Run an ordered step list (open / run+expectExitCode / assert / capture) and write `junit.xml`, `results.json`, and a screenshot-embedded `summary.md` under `artifacts/testplans/<runId>`; returns the roll-up and host paths. |
| `sandbox_snapshot` | Capture a baseline of files (common install roots), registry values (Uninstall/Run keys), installed programs, and services into `artifacts/snapshots/<id>`; roots overridable, with caps and truncated flags. |
| `sandbox_diff_snapshots` | Diff two snapshots and report added/removed/changed per section; writes `diff.json` + `diff.md` under `artifacts/snapshots/diffs/<diffId>`. Powers footprint docs and uninstall-residue checks. |
| `sandbox_start_job` / `sandbox_job_status` / `sandbox_job_cancel` | Run long PowerShell operations asynchronously, poll status/log tails, and cancel the process tree if needed. |
| `sandbox_intune_prereqs` | Find or download Microsoft's IntuneWinAppUtil.exe into the shared `tools` folder and report version/source information. |
| `sandbox_intune_package_win32` | Test install, verify detection, test uninstall, verify detection absence, then run IntuneWinAppUtil.exe to create a `.intunewin` package under shared `artifacts/intune`, with host paths and deployment metadata suggestions. |
| `sandbox_center_window` | Center the foreground window for clean screenshots. |
| `sandbox_annotate` | Draw boxes/arrows/labels/spotlight/redact on a screenshot (screen or image coords; screen mode is capture-offset aware, so window/region shots annotate correctly). `redact` solid-fills or pixelates a region for masking sensitive data. |
| `sandbox_record_start` / `sandbox_record_stop` | Auto-record a guide: while active, each action (open/click/double_click/invoke/type/key) appends a captioned, target-annotated screenshot step to the named guide. |
| `sandbox_guide_step` / `sandbox_guide_build` / `sandbox_guide_reset` | Record captioned (optionally annotated) screenshot steps into a named guide, then assemble them into Markdown, self-contained HTML, and/or PDF documents with embedded images. |

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
