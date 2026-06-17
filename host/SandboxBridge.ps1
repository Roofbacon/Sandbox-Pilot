[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("init", "start", "prepare-guide", "prepare-socket", "reload-agent", "bundle-tesseract", "connect", "set-resolution", "attach", "attach-socket", "set-dns", "list", "send", "screenshot", "ui-tree", "center-window", "inventory", "processes", "click", "type", "paste", "set-focused-text", "key", "run-ps", "run-cmd", "open", "wait-result", "stop-agent", "clean")]
    [string]$Action,

    [string]$Type,
    [string]$Text,
    [string]$Command,
    [string]$Key,
    [string]$Id,
    [string]$SandboxId,
    [int]$X,
    [int]$Y,
    [string]$Button = "left",
    [int]$Milliseconds = 1000,
    [int]$TimeoutSeconds = 30,
    [string]$Scope = "window",
    [int]$MaxDepth = 12,
    [int]$MaxNodes = 400,
    [switch]$OnlyInteractive,
    [int]$MaxWidth = 1280,
    [int]$Quality = 70,
    [int]$Width = 1920,
    [int]$Height = 1080,
    [switch]$Wait
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BridgeRoot = Join-Path $ProjectRoot "bridge"
$GuestAgentSource = Join-Path $ProjectRoot "guest\SandboxAgent.ps1"
$GuestAgentInBridge = Join-Path $BridgeRoot "SandboxAgent.ps1"
$CommandsDir = Join-Path $BridgeRoot "commands"
$ProcessedDir = Join-Path $BridgeRoot "processed"
$ResultsDir = Join-Path $BridgeRoot "results"
$ArtifactsDir = Join-Path $BridgeRoot "artifacts"
$ScreenshotsDir = Join-Path $ArtifactsDir "screenshots"
$LogsDir = Join-Path $BridgeRoot "logs"
$ConfigPath = Join-Path $BridgeRoot "ai-control.wsb"
$StartAgentCmdPath = Join-Path $BridgeRoot "StartSandboxAgent.cmd"
$StartAgentSocketCmdPath = Join-Path $BridgeRoot "StartSandboxAgentSocket.cmd"
$SetDnsCmdPath = Join-Path $BridgeRoot "SetGoogleDns.cmd"
$SocketPort = 8787

function Initialize-Bridge {
    foreach ($dir in @($BridgeRoot, $CommandsDir, $ProcessedDir, $ResultsDir, $ArtifactsDir, $ScreenshotsDir, $LogsDir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }

    Copy-Item -Force -Path $GuestAgentSource -Destination $GuestAgentInBridge

    $startAgentCmd = @"
@echo off
echo %DATE% %TIME% StartSandboxAgent.cmd invoked>> C:\SandboxBridge\logs\start-agent.cmd.log
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\SandboxBridge\SandboxAgent.ps1
"@
    Set-Content -Path $StartAgentCmdPath -Value $startAgentCmd -Encoding ASCII

    $startAgentSocketCmd = @"
@echo off
echo %DATE% %TIME% StartSandboxAgentSocket.cmd invoked>> C:\SandboxBridge\logs\start-agent-socket.cmd.log
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\SandboxBridge\SandboxAgent.ps1 -SocketPort $SocketPort
"@
    Set-Content -Path $StartAgentSocketCmdPath -Value $startAgentSocketCmd -Encoding ASCII

    $setDnsCmd = @'
@echo off
echo %DATE% %TIME% SetGoogleDns.cmd invoked>> C:\SandboxBridge\logs\set-dns.cmd.log
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses 8.8.8.8,8.8.4.4 }; ipconfig /flushdns"
'@
    Set-Content -Path $SetDnsCmdPath -Value $setDnsCmd -Encoding ASCII

    $hostFolder = [System.Security.SecurityElement]::Escape((Resolve-Path $BridgeRoot).Path)
    $config = @"
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$hostFolder</HostFolder>
      <SandboxFolder>C:\SandboxBridge</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <ClipboardRedirection>Enable</ClipboardRedirection>
  <Networking>Default</Networking>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\SandboxBridge\SandboxAgent.ps1</Command>
  </LogonCommand>
</Configuration>
"@

    Set-Content -Path $ConfigPath -Value $config -Encoding UTF8
    [pscustomobject]@{
        bridgeRoot = (Resolve-Path $BridgeRoot).Path
        configPath = (Resolve-Path $ConfigPath).Path
        guestAgent = "C:\SandboxBridge\SandboxAgent.ps1"
    }
}

function Get-RunningSandboxes {
    $raw = & wsb list --raw 2>&1 | Out-String
    try {
        return $raw | ConvertFrom-Json
    }
    catch {
        return [pscustomobject]@{ raw = $raw }
    }
}

function Start-SandboxWithAgent {
    Initialize-Bridge | Out-Null
    $config = Get-Content -Path $ConfigPath -Raw
    $raw = & wsb start --raw --config $config 2>&1 | Out-String
    try {
        return $raw | ConvertFrom-Json
    }
    catch {
        return [pscustomobject]@{ raw = $raw; configPath = (Resolve-Path $ConfigPath).Path }
    }
}

function Get-DefaultSandboxId {
    $list = Get-RunningSandboxes
    if ($list.WindowsSandboxEnvironments -and $list.WindowsSandboxEnvironments.Count -gt 0) {
        return [string]$list.WindowsSandboxEnvironments[0].Id
    }

    throw "No running Windows Sandbox session found. Start one first or run the start action."
}

function Attach-BridgeToSandbox {
    param([string]$TargetSandboxId)

    Initialize-Bridge | Out-Null
    if (-not $TargetSandboxId) {
        $TargetSandboxId = Get-DefaultSandboxId
    }

    $hostPath = (Resolve-Path $BridgeRoot).Path
    & wsb share --id $TargetSandboxId --host-path $hostPath --sandbox-path "C:\SandboxBridge" --allow-write | Out-Null

    $launchCommand = 'cmd.exe /c C:\SandboxBridge\StartSandboxAgent.cmd'
    & wsb exec --id $TargetSandboxId --run-as ExistingLogin --command $launchCommand | Out-Null

    [pscustomobject]@{
        sandboxId = $TargetSandboxId
        bridgeRoot = $hostPath
        sandboxPath = "C:\SandboxBridge"
        agent = "C:\SandboxBridge\SandboxAgent.ps1"
    }
}

function Attach-SocketAgent {
    param([string]$TargetSandboxId)

    Initialize-Bridge | Out-Null
    if (-not $TargetSandboxId) {
        $TargetSandboxId = Get-DefaultSandboxId
    }

    # Clear any stale endpoint so the host waits for the fresh one.
    $endpoint = Join-Path $ResultsDir "agent-endpoint.json"
    if (Test-Path $endpoint) { Remove-Item -Force $endpoint }

    $hostPath = (Resolve-Path $BridgeRoot).Path
    & wsb share --id $TargetSandboxId --host-path $hostPath --sandbox-path "C:\SandboxBridge" --allow-write | Out-Null

    $launchCommand = 'cmd.exe /c C:\SandboxBridge\StartSandboxAgentSocket.cmd'
    & wsb exec --id $TargetSandboxId --run-as ExistingLogin --command $launchCommand | Out-Null

    [pscustomobject]@{
        sandboxId = $TargetSandboxId
        bridgeRoot = $hostPath
        sandboxPath = "C:\SandboxBridge"
        transport = "socket"
        socketPort = $SocketPort
        endpointFile = "results\agent-endpoint.json"
    }
}

function Connect-SandboxWindow {
    param([string]$TargetSandboxId)

    if (-not $TargetSandboxId) {
        $TargetSandboxId = Get-DefaultSandboxId
    }

    Start-Process -FilePath "wsb.exe" -ArgumentList @("connect", "--id", $TargetSandboxId) | Out-Null
    [pscustomobject]@{
        sandboxId = $TargetSandboxId
        connected = $true
        note = "Wait for the Windows Sandbox window to finish opening/resizing before taking screenshots."
    }
}

function Set-SandboxResolution {
    # Force a deterministic guest resolution. The Windows Sandbox guest desktop is an RDP
    # session whose size tracks the client window's client area; left to chance it boots at a
    # tiny fallback (200x200 / 640x480 — a postage-stamp desktop) or inherits the full host
    # resolution on a high-DPI monitor (everything microscopic). We size the host-side
    # "Windows Sandbox" window so the guest renders at a clean, screenshot-friendly size.
    param([int]$Width = 1920, [int]$Height = 1080, [int]$TimeoutSeconds = 12)

    if (-not ([System.Management.Automation.PSTypeName]'SbxWin').Type) {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SbxWin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
    }
    # DPI-aware so MoveWindow coordinates are real device pixels (matches the guest's pixels).
    try { [SbxWin]::SetProcessDPIAware() | Out-Null } catch { }

    # The client area is ~16px narrower and ~41px shorter than the guest desktop it produces
    # (RDP chrome + non-client frame), so pad the requested guest size to get the outer window.
    $outerW = $Width + 16
    $outerH = $Height + 41

    # The "wsb connect" window can take a few seconds to appear; poll for it.
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $hwnd = [IntPtr]::Zero
    while ((Get-Date) -lt $deadline) {
        $proc = Get-Process -Name "WindowsSandboxRemoteSession" -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($proc) { $hwnd = $proc.MainWindowHandle; break }
        $byTitle = [SbxWin]::FindWindow($null, "Windows Sandbox")
        if ($byTitle -ne [IntPtr]::Zero) { $hwnd = $byTitle; break }
        Start-Sleep -Milliseconds 500
    }
    if ($hwnd -eq [IntPtr]::Zero) {
        return [pscustomobject]@{ resized = $false; reason = "Windows Sandbox window not found"; requested = @($Width, $Height) }
    }

    # Resize twice — the window is often still settling right after connect, and a second pass
    # makes the final size stick.
    for ($i = 0; $i -lt 2; $i++) {
        [SbxWin]::ShowWindow($hwnd, 9) | Out-Null    # SW_RESTORE (leave maximized state)
        Start-Sleep -Milliseconds 400
        [SbxWin]::MoveWindow($hwnd, 40, 30, $outerW, $outerH, $true) | Out-Null
        [SbxWin]::SetForegroundWindow($hwnd) | Out-Null
        Start-Sleep -Milliseconds 900
    }
    [pscustomobject]@{ resized = $true; hwnd = [int64]$hwnd; requested = @($Width, $Height) }
}

function Set-SandboxGoogleDns {
    param([string]$TargetSandboxId)

    Initialize-Bridge | Out-Null
    if (-not $TargetSandboxId) {
        $TargetSandboxId = Get-DefaultSandboxId
    }

    $hostPath = (Resolve-Path $BridgeRoot).Path
    & wsb share --id $TargetSandboxId --host-path $hostPath --sandbox-path "C:\SandboxBridge" --allow-write | Out-Null
    $raw = & wsb exec --id $TargetSandboxId --run-as System --command 'cmd.exe /c C:\SandboxBridge\SetGoogleDns.cmd' --raw 2>&1 | Out-String

    $result = $null
    try {
        $result = $raw | ConvertFrom-Json
    }
    catch {
        $result = [pscustomobject]@{ raw = $raw }
    }

    [pscustomobject]@{
        sandboxId = $TargetSandboxId
        dnsServers = @("8.8.8.8", "8.8.4.4")
        exec = $result
        logPath = "C:\SandboxBridge\logs\set-dns.cmd.log"
    }
}

function Prepare-SandboxForGuide {
    Initialize-Bridge | Out-Null

    $list = Get-RunningSandboxes
    if ($list.WindowsSandboxEnvironments -and $list.WindowsSandboxEnvironments.Count -gt 0) {
        $targetId = [string]$list.WindowsSandboxEnvironments[0].Id
    }
    else {
        $started = Start-SandboxWithAgent
        $targetId = [string]$started.Id
        Start-Sleep -Seconds 8
    }

    Connect-SandboxWindow -TargetSandboxId $targetId | Out-Null
    Start-Sleep -Seconds 4
    try { Set-SandboxResolution | Out-Null } catch { }
    $dns = Set-SandboxGoogleDns -TargetSandboxId $targetId
    $attach = Attach-BridgeToSandbox -TargetSandboxId $targetId

    [pscustomobject]@{
        sandboxId = $targetId
        connected = $true
        dnsServers = $dns.dnsServers
        bridgeRoot = $attach.bridgeRoot
        sandboxPath = $attach.sandboxPath
        nextCheck = ".\host\SandboxBridge.ps1 send -Type screen_info -Wait -TimeoutSeconds 30"
    }
}

function Prepare-SandboxForSocket {
    Initialize-Bridge | Out-Null

    $list = Get-RunningSandboxes
    if ($list.WindowsSandboxEnvironments -and $list.WindowsSandboxEnvironments.Count -gt 0) {
        $targetId = [string]$list.WindowsSandboxEnvironments[0].Id
    }
    else {
        $started = Start-SandboxWithAgent
        $targetId = [string]$started.Id
        Start-Sleep -Seconds 8
    }

    Connect-SandboxWindow -TargetSandboxId $targetId | Out-Null
    Start-Sleep -Seconds 4
    $dns = Set-SandboxGoogleDns -TargetSandboxId $targetId

    # Stop any auto-started (file-mode) agent so only the socket agent runs.
    $hostPath = (Resolve-Path $BridgeRoot).Path
    & wsb share --id $targetId --host-path $hostPath --sandbox-path "C:\SandboxBridge" --allow-write | Out-Null
    & wsb exec --id $targetId --run-as ExistingLogin --command 'cmd.exe /c C:\SandboxBridge\KillPowerShellProcesses.cmd' | Out-Null
    Start-Sleep -Seconds 2

    Attach-SocketAgent -TargetSandboxId $targetId | Out-Null

    # Wait for the agent to publish its endpoint so the caller knows it is socket-ready.
    $endpointPath = Join-Path $ResultsDir "agent-endpoint.json"
    $deadline = (Get-Date).AddSeconds(45)
    while (-not (Test-Path $endpointPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    $endpoint = $null
    if (Test-Path $endpointPath) {
        try { $endpoint = Get-Content -Path $endpointPath -Raw | ConvertFrom-Json } catch { }
    }

    # Force a usable guest resolution (the session otherwise boots at a tiny RDP fallback).
    $resolution = $null
    try { $resolution = Set-SandboxResolution } catch { }

    [pscustomobject]@{
        sandboxId = $targetId
        connected = $true
        transport = "socket"
        dnsServers = $dns.dnsServers
        endpoint = $endpoint
        resolution = $resolution
        ready = [bool]$endpoint
    }
}

function Reload-SocketAgent {
    # Reliable in-place agent reload for a RUNNING Sandbox after editing the agent script.
    # Copies the latest agent, waits for the shared-folder to propagate it to the guest,
    # kills every agent (System scope, so no duplicate-agent flapping), starts exactly one
    # socket agent, waits for its endpoint, and reconnects the interactive desktop.
    param([string]$TargetSandboxId, [int]$PropagateSeconds = 35)

    Initialize-Bridge | Out-Null
    if (-not $TargetSandboxId) { $TargetSandboxId = Get-DefaultSandboxId }

    $hostPath = (Resolve-Path $BridgeRoot).Path
    & wsb share --id $TargetSandboxId --host-path $hostPath --sandbox-path "C:\SandboxBridge" --allow-write | Out-Null

    # Let the (just re-copied) script propagate to the guest before starting the agent,
    # otherwise the agent runs a stale cached copy of the script.
    Start-Sleep -Seconds $PropagateSeconds

    & wsb exec --id $TargetSandboxId --run-as System --command 'cmd.exe /c C:\SandboxBridge\KillPowerShellProcesses.cmd' | Out-Null
    Start-Sleep -Seconds 3

    $endpoint = Join-Path $ResultsDir "agent-endpoint.json"
    if (Test-Path $endpoint) { Remove-Item -Force $endpoint }

    & wsb exec --id $TargetSandboxId --run-as ExistingLogin --command 'cmd.exe /c C:\SandboxBridge\StartSandboxAgentSocket.cmd' | Out-Null
    $deadline = (Get-Date).AddSeconds(45)
    while (-not (Test-Path $endpoint) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }

    # Killing PowerShell drops the interactive session to 200x200; reconnect + resize for real capture.
    Start-Process -FilePath "wsb.exe" -ArgumentList @("connect", "--id", $TargetSandboxId) | Out-Null
    Start-Sleep -Seconds 6
    $resolution = $null
    try { $resolution = Set-SandboxResolution } catch { }

    $ep = $null
    if (Test-Path $endpoint) { try { $ep = Get-Content -Path $endpoint -Raw | ConvertFrom-Json } catch { } }
    [pscustomobject]@{
        sandboxId = $TargetSandboxId
        reloaded = $true
        ready = [bool]$ep
        endpoint = $ep
        resolution = $resolution
    }
}

function Bundle-Tesseract {
    # One-command offline-OCR setup: download Tesseract on the host, then (inside a running
    # Sandbox, elevated) install it, copy the runtime into the mapped tools\tesseract folder so
    # it persists to the host, and trim training tools. Idempotent — skips if already bundled.
    param([string]$TargetSandboxId)

    Initialize-Bridge | Out-Null
    $tessExe = Join-Path $BridgeRoot "tools\tesseract\tesseract.exe"
    if (Test-Path $tessExe) {
        return [pscustomobject]@{ bundled = $true; alreadyPresent = $true; path = $tessExe }
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget not found on the host; cannot download Tesseract."
    }
    if (-not $TargetSandboxId) { $TargetSandboxId = Get-DefaultSandboxId }

    # 1. Download the installer on the host (no admin needed).
    $dlDir = Join-Path $BridgeRoot "tools\_tess_installer"
    New-Item -ItemType Directory -Force -Path $dlDir | Out-Null
    & winget download --id UB-Mannheim.TesseractOCR --accept-source-agreements --accept-package-agreements -d $dlDir --disable-interactivity | Out-Null

    # 2. Share + let the installer and InstallTesseract.ps1 propagate into the guest.
    $hostPath = (Resolve-Path $BridgeRoot).Path
    & wsb share --id $TargetSandboxId --host-path $hostPath --sandbox-path "C:\SandboxBridge" --allow-write | Out-Null
    Start-Sleep -Seconds 30

    # 3. Install + copy + trim inside the guest (System = elevated, no UAC).
    $marker = Join-Path $ResultsDir "tess-bundle.txt"
    if (Test-Path $marker) { Remove-Item -Force $marker }
    & wsb exec --id $TargetSandboxId --run-as System --command 'cmd.exe /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\SandboxBridge\InstallTesseract.ps1' | Out-Null
    $deadline = (Get-Date).AddSeconds(240)
    while (-not (Test-Path $marker) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
    $detail = if (Test-Path $marker) { (Get-Content -Path $marker -Raw).Trim() } else { "timed out waiting for install" }

    # 4. Clean up the downloaded installer.
    Remove-Item -Recurse -Force $dlDir -ErrorAction SilentlyContinue

    [pscustomobject]@{
        bundled = (Test-Path $tessExe)
        alreadyPresent = $false
        detail = $detail
        path = $tessExe
    }
}

function Wait-BridgeResult {
    param(
        [Parameter(Mandatory = $true)][string]$CommandId,
        [int]$Timeout = 30
    )

    $deadline = (Get-Date).AddSeconds($Timeout)
    $resultPath = Join-Path $ResultsDir "$CommandId.json"

    while ((Get-Date) -lt $deadline) {
        if (Test-Path $resultPath) {
            return Get-Content -Path $resultPath -Raw | ConvertFrom-Json
        }
        Start-Sleep -Milliseconds 250
    }

    throw "Timed out waiting for result $CommandId after $Timeout seconds."
}

function Send-BridgeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$CommandType,
        [hashtable]$Args = @{},
        [switch]$WaitForResult,
        [int]$Timeout = 30
    )

    Initialize-Bridge | Out-Null

    $commandId = [guid]::NewGuid().ToString()
    $payload = [ordered]@{
        id = $commandId
        type = $CommandType
        createdAt = (Get-Date).ToString("o")
        args = $Args
    }

    $tmpPath = Join-Path $CommandsDir "$commandId.tmp"
    $finalPath = Join-Path $CommandsDir "$commandId.json"
    $payload | ConvertTo-Json -Depth 20 | Set-Content -Path $tmpPath -Encoding UTF8
    Move-Item -Force -Path $tmpPath -Destination $finalPath

    if ($WaitForResult) {
        return Wait-BridgeResult -CommandId $commandId -Timeout $Timeout
    }

    [pscustomobject]@{
        id = $commandId
        type = $CommandType
        commandPath = $finalPath
        resultPath = Join-Path $ResultsDir "$commandId.json"
    }
}

function Remove-BridgeState {
    Initialize-Bridge | Out-Null
    foreach ($dir in @($CommandsDir, $ProcessedDir, $ResultsDir, $ArtifactsDir, $LogsDir)) {
        if (Test-Path $dir) {
            Get-ChildItem -Path $dir -Force | Remove-Item -Recurse -Force
        }
    }
    Initialize-Bridge
}

switch ($Action) {
    "init" {
        Initialize-Bridge | ConvertTo-Json -Depth 10
    }
    "start" {
        Start-SandboxWithAgent | ConvertTo-Json -Depth 10
    }
    "prepare-guide" {
        Prepare-SandboxForGuide | ConvertTo-Json -Depth 10
    }
    "prepare-socket" {
        Prepare-SandboxForSocket | ConvertTo-Json -Depth 10
    }
    "reload-agent" {
        Reload-SocketAgent -TargetSandboxId $SandboxId | ConvertTo-Json -Depth 10
    }
    "bundle-tesseract" {
        Bundle-Tesseract -TargetSandboxId $SandboxId | ConvertTo-Json -Depth 10
    }
    "connect" {
        $c = Connect-SandboxWindow -TargetSandboxId $SandboxId
        Start-Sleep -Seconds 4
        $res = $null
        try { $res = Set-SandboxResolution -Width $Width -Height $Height } catch { }
        $c | Add-Member -NotePropertyName resolution -NotePropertyValue $res -Force
        $c | ConvertTo-Json -Depth 10
    }
    "set-resolution" {
        Set-SandboxResolution -Width $Width -Height $Height | ConvertTo-Json -Depth 10
    }
    "attach" {
        Attach-BridgeToSandbox -TargetSandboxId $SandboxId | ConvertTo-Json -Depth 10
    }
    "attach-socket" {
        Attach-SocketAgent -TargetSandboxId $SandboxId | ConvertTo-Json -Depth 10
    }
    "set-dns" {
        Set-SandboxGoogleDns -TargetSandboxId $SandboxId | ConvertTo-Json -Depth 10
    }
    "list" {
        Get-RunningSandboxes | ConvertTo-Json -Depth 10
    }
    "send" {
        if (-not $Type) { throw "Use -Type with the send action." }
        Send-BridgeCommand -CommandType $Type -Args @{ text = $Text; command = $Command; keys = $Key; x = $X; y = $Y; button = $Button; milliseconds = $Milliseconds } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "screenshot" {
        Send-BridgeCommand -CommandType "screenshot" -Args @{ maxWidth = $MaxWidth; quality = $Quality } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "ui-tree" {
        Send-BridgeCommand -CommandType "ui_tree" -Args @{ scope = $Scope; maxDepth = $MaxDepth; maxNodes = $MaxNodes; onlyInteractive = [bool]$OnlyInteractive } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "center-window" {
        Send-BridgeCommand -CommandType "center_window" -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "inventory" {
        Send-BridgeCommand -CommandType "inventory" -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "processes" {
        Send-BridgeCommand -CommandType "processes" -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "click" {
        Send-BridgeCommand -CommandType "click" -Args @{ x = $X; y = $Y; button = $Button } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "type" {
        if (-not $Text) { throw "Use -Text with the type action." }
        Send-BridgeCommand -CommandType "type" -Args @{ text = $Text } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "paste" {
        if (-not $Text) { throw "Use -Text with the paste action." }
        Send-BridgeCommand -CommandType "paste" -Args @{ text = $Text } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "set-focused-text" {
        if (-not $Text) { throw "Use -Text with the set-focused-text action." }
        Send-BridgeCommand -CommandType "set_focused_text" -Args @{ text = $Text } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "key" {
        if (-not $Key) { throw "Use -Key with the key action. Example: -Key '{ENTER}'" }
        Send-BridgeCommand -CommandType "key" -Args @{ keys = $Key } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "run-ps" {
        if (-not $Command) { throw "Use -Command with the run-ps action." }
        Send-BridgeCommand -CommandType "run_ps" -Args @{ command = $Command } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "run-cmd" {
        if (-not $Command) { throw "Use -Command with the run-cmd action." }
        Send-BridgeCommand -CommandType "run_cmd" -Args @{ command = $Command } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "open" {
        if (-not $Command) { throw "Use -Command with the open action. It should be a file path, executable, or URL." }
        Send-BridgeCommand -CommandType "open" -Args @{ target = $Command } -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "wait-result" {
        if (-not $Id) { throw "Use -Id with the wait-result action." }
        Wait-BridgeResult -CommandId $Id -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "stop-agent" {
        Send-BridgeCommand -CommandType "stop_agent" -WaitForResult:$Wait -Timeout $TimeoutSeconds | ConvertTo-Json -Depth 20
    }
    "clean" {
        Remove-BridgeState | ConvertTo-Json -Depth 10
    }
}
