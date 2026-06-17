param(
    # When > 0, run the low-latency socket transport (guest listens, host connects out)
    # instead of the file-polling transport. The shared folder is then used only to
    # publish the guest's connection endpoint.
    [int]$SocketPort = 0
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$BridgeRoot = $PSScriptRoot
$CommandsDir = Join-Path $BridgeRoot "commands"
$ProcessedDir = Join-Path $BridgeRoot "processed"
$ResultsDir = Join-Path $BridgeRoot "results"
$ArtifactsDir = Join-Path $BridgeRoot "artifacts"
$ScreenshotsDir = Join-Path $ArtifactsDir "screenshots"
$IntuneArtifactsDir = Join-Path $ArtifactsDir "intune"
$JobsDir = Join-Path $ArtifactsDir "jobs"
$ToolsDir = Join-Path $BridgeRoot "tools"
$LogsDir = Join-Path $BridgeRoot "logs"
$LogPath = Join-Path $LogsDir "sandbox-agent.log"

foreach ($dir in @($CommandsDir, $ProcessedDir, $ResultsDir, $ArtifactsDir, $ScreenshotsDir, $IntuneArtifactsDir, $JobsDir, $ToolsDir, $LogsDir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

function Write-AgentLog {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format "o"), $Message
    Add-Content -Path $LogPath -Value $line
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class SandboxInput {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public const uint LEFTDOWN = 0x0002;
    public const uint LEFTUP = 0x0004;
    public const uint RIGHTDOWN = 0x0008;
    public const uint RIGHTUP = 0x0010;
    public const uint MIDDLEDOWN = 0x0020;
    public const uint MIDDLEUP = 0x0040;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_SHOWWINDOW = 0x0040;
}
"@

# Make this process DPI-aware once, so in-process screen capture reports true pixel sizes.
try { [SandboxInput]::SetProcessDPIAware() | Out-Null } catch { }

function New-Screenshot {
    param(
        [string]$Id,
        [int]$MaxWidth = 1280,
        [int]$Quality = 70,
        $Region = $null,
        [bool]$Window = $false,
        [int]$KeepRecent = 40
    )

    $path = Join-Path $ScreenshotsDir "$Id.jpg"
    $metaPath = Join-Path $ScreenshotsDir "$Id.json"

    # Capture rectangle: a specific window, an explicit region, or the full virtual screen.
    # Region/window produce sharper, cheaper images than the whole desktop.
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $ox = $vs.Left; $oy = $vs.Top; $cw = $vs.Width; $ch = $vs.Height
    $captured = "screen"
    if ($Window) {
        $hwnd = [SandboxInput]::GetForegroundWindow()
        if ($hwnd -ne [IntPtr]::Zero) {
            $r = New-Object SandboxInput+RECT
            if ([SandboxInput]::GetWindowRect($hwnd, [ref]$r)) {
                $ox = $r.Left; $oy = $r.Top; $cw = $r.Right - $r.Left; $ch = $r.Bottom - $r.Top
                $captured = "window"
            }
        }
    }
    elseif ($Region) {
        $ox = [int]$Region[0]; $oy = [int]$Region[1]; $cw = [int]$Region[2]; $ch = [int]$Region[3]
        $captured = "region"
    }
    if ($cw -lt 1) { $cw = 1 }
    if ($ch -lt 1) { $ch = 1 }

    # Capture in-process (the agent is DPI-aware from startup) — no per-screenshot child spawn.
    $bitmap = New-Object System.Drawing.Bitmap $cw, $ch
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $scaled = $null
    $scaledGraphics = $null
    try {
        $graphics.CopyFromScreen($ox, $oy, 0, 0, (New-Object System.Drawing.Size($cw, $ch)))

        $scale = 1.0
        if ($MaxWidth -gt 0 -and $cw -gt $MaxWidth) { $scale = $MaxWidth / [double]$cw }
        $targetWidth = [int]($cw * $scale)
        $targetHeight = [int]($ch * $scale)
        if ($targetWidth -lt 1) { $targetWidth = 1 }
        if ($targetHeight -lt 1) { $targetHeight = 1 }

        $scaled = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight
        $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
        $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $scaledGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $scaledGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $scaledGraphics.DrawImage($bitmap, 0, 0, $targetWidth, $targetHeight)

        $jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
            Where-Object { $_.FormatID -eq [System.Drawing.Imaging.ImageFormat]::Jpeg.Guid } |
            Select-Object -First 1
        $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters 1
        $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
        $scaled.Save($path, $jpegCodec, $encoderParams)
    }
    finally {
        if ($scaledGraphics) { $scaledGraphics.Dispose() }
        if ($scaled) { $scaled.Dispose() }
        $graphics.Dispose()
        $bitmap.Dispose()
    }

    $meta = [pscustomobject]@{
        path = $path
        format = "jpeg"
        quality = $Quality
        captured = $captured
        width = $targetWidth
        height = $targetHeight
        originalWidth = $cw
        originalHeight = $ch
        scale = $scale
        left = $ox
        top = $oy
    }
    [System.IO.File]::WriteAllText($metaPath, ($meta | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

    # Rotation: keep only the most recent screenshots (jpg + json sidecar) so the folder
    # doesn't grow unbounded. The just-saved one is newest, so it is never pruned.
    if ($KeepRecent -gt 0) {
        try {
            $old = Get-ChildItem -Path $ScreenshotsDir -Filter *.jpg -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip $KeepRecent
            foreach ($f in $old) {
                Remove-Item -Force $f.FullName -ErrorAction SilentlyContinue
                $j = [System.IO.Path]::ChangeExtension($f.FullName, ".json")
                if (Test-Path $j) { Remove-Item -Force $j -ErrorAction SilentlyContinue }
            }
        }
        catch { }
    }

    $meta
}

function Get-InstalledPrograms {
    $registryPaths = @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )

    $programs = foreach ($path in $registryPaths) {
        Get-ItemProperty -Path $path -ErrorAction SilentlyContinue |
            Where-Object { Get-ObjectPropertyValue -Object $_ -Name "DisplayName" } |
            Select-Object DisplayName, DisplayVersion, Publisher, InstallDate, InstallLocation, UninstallString
    }

    $programs |
        Sort-Object DisplayName, DisplayVersion, Publisher -Unique |
        Select-Object @{Name="name";Expression={$_.DisplayName}},
            @{Name="version";Expression={$_.DisplayVersion}},
            @{Name="publisher";Expression={$_.Publisher}},
            @{Name="installDate";Expression={$_.InstallDate}},
            @{Name="installLocation";Expression={$_.InstallLocation}},
            @{Name="uninstallString";Expression={$_.UninstallString}}
}

function Get-DefaultDownloadsPath {
    $path = Join-Path $env:USERPROFILE "Downloads"
    if (Test-Path -LiteralPath $path) { return $path }
    return "C:\Users\Public\Downloads"
}

function ConvertTo-InstallerCommandLiteral {
    param([string]$Value)
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-ObjectPropertyValue {
    param($Object, [string]$Name, $Default = $null)

    if ($null -eq $Object -or -not $Name) { return $Default }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $Default
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $Default
}

function Get-FileStringSample {
    param([string]$Path, [int]$MaxBytes = 8388608)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $count = [int][Math]::Min($stream.Length, $MaxBytes)
        $buffer = New-Object byte[] $count
        [void]$stream.Read($buffer, 0, $count)
        return [System.Text.Encoding]::ASCII.GetString($buffer)
    }
    finally {
        $stream.Dispose()
    }
}

function Get-InstallerTechnology {
    param([System.IO.FileInfo]$File)

    $extension = $File.Extension.ToLowerInvariant()
    if ($extension -eq ".msi") { return @{ type = "msi"; confidence = "high"; evidence = @("File extension is .msi.") } }
    if ($extension -eq ".msix") { return @{ type = "msix"; confidence = "high"; evidence = @("File extension is .msix.") } }
    if ($extension -eq ".appx") { return @{ type = "appx"; confidence = "high"; evidence = @("File extension is .appx.") } }
    if ($extension -eq ".zip") { return @{ type = "archive"; confidence = "medium"; evidence = @("File extension is .zip.") } }

    $evidence = New-Object System.Collections.ArrayList
    $type = "exe"
    $confidence = "low"
    if ($extension -eq ".exe") {
        $version = $File.VersionInfo
        $versionText = @($version.FileDescription, $version.ProductName, $version.CompanyName, $version.OriginalFilename) -join " "
        if ($versionText -match "InstallShield") { $type = "installshield"; $confidence = "medium"; [void]$evidence.Add("Version info mentions InstallShield.") }
        elseif ($versionText -match "Advanced Installer") { $type = "advanced_installer"; $confidence = "medium"; [void]$evidence.Add("Version info mentions Advanced Installer.") }
        elseif ($versionText -match "Squirrel") { $type = "squirrel"; $confidence = "medium"; [void]$evidence.Add("Version info mentions Squirrel.") }
        elseif ($versionText -match "Setup|Installer") { [void]$evidence.Add("Version info looks like a setup/installer executable.") }

        try {
            $sample = Get-FileStringSample -Path $File.FullName
            if ($sample -match "Inno Setup") { $type = "inno_setup"; $confidence = "high"; [void]$evidence.Add("Binary strings contain 'Inno Setup'.") }
            elseif ($sample -match "Nullsoft|NSIS") { $type = "nsis"; $confidence = "high"; [void]$evidence.Add("Binary strings contain NSIS markers.") }
            elseif ($sample -match "Burn|WixBundle|WixStdBA") { $type = "wix_burn"; $confidence = "medium"; [void]$evidence.Add("Binary strings contain WiX Burn markers.") }
            elseif ($sample -match "InstallShield") { $type = "installshield"; $confidence = "medium"; [void]$evidence.Add("Binary strings contain InstallShield markers.") }
            elseif ($sample -match "Advanced Installer") { $type = "advanced_installer"; $confidence = "medium"; [void]$evidence.Add("Binary strings contain Advanced Installer markers.") }
        }
        catch { [void]$evidence.Add("Could not sample executable strings: $($_.Exception.Message)") }

        $nearbyMsi = @(Get-ChildItem -LiteralPath $File.DirectoryName -Filter *.msi -File -ErrorAction SilentlyContinue)
        if ($nearbyMsi.Count -gt 0 -and $File.Name -match "^setup\.exe$") {
            $type = "msi_bundle_wrapper"
            $confidence = "high"
            [void]$evidence.Add("Setup.exe sits beside $($nearbyMsi.Count) MSI file(s).")
        }
    }

    if ($evidence.Count -eq 0) { [void]$evidence.Add("No installer technology marker found beyond file extension.") }
    return @{ type = $type; confidence = $confidence; evidence = @($evidence) }
}

function Get-MsiPropertyMap {
    param($Database)

    $properties = @{}
    $view = $null
    try {
        $view = $Database.OpenView('SELECT `Property`,`Value` FROM `Property`')
        $view.Execute()
        while ($record = $view.Fetch()) {
            $properties[$record.StringData(1)] = $record.StringData(2)
        }
    }
    finally {
        if ($view) { $view.Close() }
    }
    return $properties
}

function Get-MsiInfo {
    param([string]$Path)

    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $null
    try {
        $database = $installer.OpenDatabase($Path, 0)
        $properties = Get-MsiPropertyMap -Database $database
        $publicProperties = @()
        foreach ($name in @($properties.GetEnumerator() | ForEach-Object { $_.Key } | Sort-Object)) {
            if ($name -cmatch '^[A-Z0-9_]+$') {
                $publicProperties += [ordered]@{ name = $name; value = $properties[$name] }
            }
        }
        $notablePattern = "REBOOT|RESTART|LOCK|PRE|DISABLE|PROFILE|CONFIG|TOKEN|ACCOUNT|SERVER|CERT|VPN|NAM|NVM|DART|POSTURE|UMBRELLA|ZTA|THOUSAND|SBL"
        $notable = @($publicProperties | Where-Object { $_.name -match $notablePattern })
        $file = Get-Item -LiteralPath $Path
        $base = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
        return [ordered]@{
            path = $file.FullName
            file = $file.Name
            productName = Get-ObjectPropertyValue -Object $properties -Name "ProductName"
            productVersion = Get-ObjectPropertyValue -Object $properties -Name "ProductVersion"
            productCode = Get-ObjectPropertyValue -Object $properties -Name "ProductCode"
            upgradeCode = Get-ObjectPropertyValue -Object $properties -Name "UpgradeCode"
            manufacturer = Get-ObjectPropertyValue -Object $properties -Name "Manufacturer"
            allUsers = Get-ObjectPropertyValue -Object $properties -Name "ALLUSERS"
            reboot = Get-ObjectPropertyValue -Object $properties -Name "REBOOT"
            publicProperties = @($publicProperties)
            notableProperties = @($notable)
            suggestedSilentCommand = "msiexec /i " + (ConvertTo-InstallerCommandLiteral $file.FullName) + " /qn /norestart /L*v " + (ConvertTo-InstallerCommandLiteral ('$env:TEMP\' + $base + "-install.log"))
        }
    }
    finally {
        if ($database) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($database) }
        if ($installer) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($installer) }
    }
}

function Get-InstallerCandidates {
    param([string]$Path = "", [bool]$Recurse = $true)

    if (-not $Path) { $Path = Get-DefaultDownloadsPath }
    if (-not (Test-Path -LiteralPath $Path)) { throw "Path does not exist: $Path" }

    $files = if ($Recurse) {
        Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction SilentlyContinue
    }
    else {
        Get-ChildItem -LiteralPath $Path -File -ErrorAction SilentlyContinue
    }
    $installerExts = @(".msi", ".exe", ".msix", ".appx", ".zip")
    $candidates = foreach ($file in $files) {
        $extension = $file.Extension.ToLowerInvariant()
        if ($installerExts -notcontains $extension) { continue }

        $tech = Get-InstallerTechnology -File $file
        $score = 10
        $reasons = New-Object System.Collections.ArrayList
        [void]$reasons.Add("Extension $extension is installable or inspectable.")
        if ($extension -eq ".msi") { $score += 60; [void]$reasons.Add("MSI supports msiexec silent switches.") }
        if ($file.Name -match "setup|install|predeploy|bootstrap") { $score += 15; [void]$reasons.Add("Filename looks like an installer entry point.") }
        if ($tech.type -eq "msi_bundle_wrapper") { $score += 25; [void]$reasons.Add("Wrapper sits beside MSI payloads.") }
        if ($tech.confidence -eq "high") { $score += 10 }

        [ordered]@{
            path = $file.FullName
            file = $file.Name
            directory = $file.DirectoryName
            extension = $extension
            size = $file.Length
            lastWriteTime = $file.LastWriteTime.ToString("o")
            technology = $tech.type
            technologyConfidence = $tech.confidence
            evidence = @($tech.evidence)
            score = $score
            reasons = @($reasons)
        }
    }

    return @($candidates | Sort-Object score, file -Descending)
}

function Get-InstallerScriptEvidence {
    param([string]$Path, [bool]$Recurse = $true)

    $files = if ($Recurse) {
        Get-ChildItem -LiteralPath $Path -File -Recurse -ErrorAction SilentlyContinue
    }
    else {
        Get-ChildItem -LiteralPath $Path -File -ErrorAction SilentlyContinue
    }
    $scriptExts = @(".hta", ".cmd", ".bat", ".ps1", ".txt", ".ini")
    $files = @($files | Where-Object { $scriptExts -contains $_.Extension.ToLowerInvariant() })
    $pattern = "msiexec|/qn|/quiet|/passive|/silent|/verysilent|/norestart|REBOOT=|LOCKDOWN|PRE_DEPLOY|DISABLE|InstallShield|Inno|NSIS"
    $evidence = foreach ($file in $files) {
        try {
            Select-String -LiteralPath $file.FullName -Pattern $pattern -CaseSensitive:$false -ErrorAction Stop |
                Select-Object -First 80 |
                ForEach-Object {
                    [ordered]@{ path = $_.Path; lineNumber = $_.LineNumber; line = ($_.Line.Trim()) }
                }
        }
        catch { }
    }
    return @($evidence)
}

function Get-InstallerFolderAnalysis {
    param([string]$Path = "", [bool]$Recurse = $true)

    if (-not $Path) { $Path = Get-DefaultDownloadsPath }
    if (-not (Test-Path -LiteralPath $Path)) { throw "Path does not exist: $Path" }
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $candidates = @(Get-InstallerCandidates -Path $resolved -Recurse $Recurse)
    $msiCandidates = @($candidates | Where-Object { $_.extension -eq ".msi" })
    $msis = foreach ($candidate in $msiCandidates) {
        try { Get-MsiInfo -Path $candidate.path }
        catch { [ordered]@{ path = $candidate.path; error = $_.Exception.Message } }
    }
    $evidence = @(Get-InstallerScriptEvidence -Path $resolved -Recurse $Recurse)
    $entrypoints = @($candidates | Sort-Object score -Descending | Select-Object -First 12)

    $kind = "unknown"
    $confidence = "low"
    $notes = New-Object System.Collections.ArrayList
    if ($msis.Count -gt 1) {
        $kind = "msi_bundle"
        $confidence = "high"
        [void]$notes.Add("Multiple MSI payloads found; install selected modules with msiexec.")
    }
    elseif ($msis.Count -eq 1) {
        $kind = "msi"
        $confidence = "high"
        [void]$notes.Add("Single MSI payload found; use msiexec /i with /qn.")
    }
    elseif ($entrypoints.Count -gt 0) {
        $kind = $entrypoints[0].technology
        $confidence = $entrypoints[0].technologyConfidence
    }
    if (@($evidence | Where-Object { $_.line -match "PRE_DEPLOY_DISABLE_VPN" }).Count -gt 0) {
        [void]$notes.Add("Script evidence references PRE_DEPLOY_DISABLE_VPN; include it when needed for Cisco module-only installs.")
    }
    if (@($evidence | Where-Object { $_.line -match "LOCKDOWN" }).Count -gt 0) {
        [void]$notes.Add("Script evidence references LOCKDOWN; add LOCKDOWN=1 if service lockdown is desired.")
    }
    if ($msis.Count -gt 0) {
        [void]$notes.Add("Use /L*v with each MSI so failures can be diagnosed from verbose logs.")
    }

    $recommendedCommands = foreach ($msi in $msis) {
        $command = Get-ObjectPropertyValue -Object $msi -Name "suggestedSilentCommand"
        if ($command) {
            [ordered]@{
                file = Get-ObjectPropertyValue -Object $msi -Name "file"
                productName = Get-ObjectPropertyValue -Object $msi -Name "productName"
                command = $command
                confidence = "high"
            }
        }
    }

    return [ordered]@{
        path = $resolved
        kind = $kind
        confidence = $confidence
        entrypoints = @($entrypoints)
        msiPackages = @($msis)
        scriptEvidence = @($evidence)
        recommendedCommands = @($recommendedCommands)
        notes = @($notes)
    }
}

function Get-TopLevelWindows {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $windows = New-Object System.Collections.ArrayList
    try {
        $w = $walker.GetFirstChild([System.Windows.Automation.AutomationElement]::RootElement)
        while ($w -and $windows.Count -lt 80) {
            try {
                $info = $w.Current
                $ct = ($info.ControlType.ProgrammaticName -replace '^ControlType\.', '')
                if ($ct -eq "Window" -and $info.Name) {
                    [void]$windows.Add([ordered]@{ name = [string]$info.Name; automationId = [string]$info.AutomationId })
                }
            }
            catch { }
            $w = $walker.GetNextSibling($w)
        }
    }
    catch { }
    return @($windows)
}

function Get-LogTail {
    param([string]$Path, [int]$TailLines = 80)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    return [ordered]@{
        path = (Resolve-Path -LiteralPath $Path).Path
        tail = @((Get-Content -LiteralPath $Path -Tail $TailLines -ErrorAction SilentlyContinue))
    }
}

function Invoke-InstallerCommandTest {
    param(
        [string]$Command,
        [int]$TimeoutMs = 120000,
        [string]$LogPath = "",
        [int]$LogTailLines = 80,
        [string]$WorkingDirectory = ""
    )

    if (-not $Command) { throw "Command is required." }
    $started = Get-Date
    $beforePrograms = @(Get-InstalledPrograms)
    $wrappedCommand = '$ProgressPreference = "SilentlyContinue"; & { ' + $Command + ' }; if ($null -ne $global:LASTEXITCODE) { exit $global:LASTEXITCODE }'
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($wrappedCommand))
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell.exe"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    if ($WorkingDirectory) {
        if (-not (Test-Path -LiteralPath $WorkingDirectory)) { throw "workingDirectory does not exist: $WorkingDirectory" }
        $psi.WorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
    }

    $process = [System.Diagnostics.Process]::Start($psi)
    $completed = $process.WaitForExit($TimeoutMs)
    $timedOut = -not $completed
    if ($timedOut) {
        try { & taskkill.exe /PID $process.Id /T /F | Out-Null } catch { try { $process.Kill() } catch { } }
    }
    $stdout = ""
    $stderr = ""
    try { $stdout = $process.StandardOutput.ReadToEnd() } catch { }
    try { $stderr = $process.StandardError.ReadToEnd() } catch { }
    $exitCode = $null
    if (-not $timedOut) { $exitCode = $process.ExitCode }

    $afterPrograms = @(Get-InstalledPrograms)
    $beforeKeys = @{}
    foreach ($p in $beforePrograms) { $beforeKeys["$($p.name)|$($p.version)|$($p.publisher)"] = $true }
    $newPrograms = @($afterPrograms | Where-Object { -not $beforeKeys.ContainsKey("$($_.name)|$($_.version)|$($_.publisher)") })

    $logs = @()
    if ($LogPath) {
        $tail = Get-LogTail -Path $LogPath -TailLines $LogTailLines
        if ($tail) { $logs += $tail }
    }
    $recentLogs = Get-ChildItem -Path $env:TEMP -File -ErrorAction SilentlyContinue |
        Where-Object { @(".log", ".txt") -contains $_.Extension.ToLowerInvariant() } |
        Where-Object { $_.LastWriteTime -ge $started } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 5
    foreach ($log in $recentLogs) {
        if ($LogPath -and ((Resolve-Path -LiteralPath $LogPath -ErrorAction SilentlyContinue).Path -eq $log.FullName)) { continue }
        $tail = Get-LogTail -Path $log.FullName -TailLines ([Math]::Min($LogTailLines, 40))
        if ($tail) { $logs += $tail }
    }

    $pendingRebootKeys = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
        "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager"
    )
    $pendingReboot = $false
    foreach ($key in $pendingRebootKeys) {
        try {
            if ($key -like "*Session Manager") {
                $value = (Get-ItemProperty -Path $key -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations
                if ($value) { $pendingReboot = $true }
            }
            elseif (Test-Path $key) { $pendingReboot = $true }
        }
        catch { }
    }

    return [ordered]@{
        command = $Command
        startedAt = $started.ToString("o")
        finishedAt = (Get-Date).ToString("o")
        timedOut = $timedOut
        timeoutMs = $TimeoutMs
        workingDirectory = $psi.WorkingDirectory
        pid = $process.Id
        exitCode = $exitCode
        stdout = $stdout
        stderr = $stderr
        newPrograms = @($newPrograms)
        visibleWindows = @(Get-TopLevelWindows)
        pendingReboot = $pendingReboot
        logs = @($logs)
    }
}

function ConvertTo-BridgeRelativePath {
    param([string]$Path)

    try {
        $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    }
    catch {
        $resolved = [System.IO.Path]::GetFullPath($Path)
    }
    $root = [System.IO.Path]::GetFullPath($BridgeRoot).TrimEnd('\')
    if ($resolved.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $resolved.Substring($root.Length).TrimStart('\')
    }
    return $null
}

function ConvertTo-CliArgument {
    param([string]$Value)

    if ($null -eq $Value) { return '""' }
    if ($Value -match '^[A-Za-z0-9_\-\.=:/\\]+$') { return $Value }
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-CapturedProcess {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutMs = 120000
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (($Arguments | ForEach-Object { ConvertTo-CliArgument $_ }) -join " ")
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $process = [System.Diagnostics.Process]::Start($psi)
    $completed = $process.WaitForExit($TimeoutMs)
    $timedOut = -not $completed
    if ($timedOut) {
        try { & taskkill.exe /PID $process.Id /T /F | Out-Null } catch { try { $process.Kill() } catch { } }
    }
    $stdout = ""
    $stderr = ""
    try { $stdout = $process.StandardOutput.ReadToEnd() } catch { }
    try { $stderr = $process.StandardError.ReadToEnd() } catch { }
    $exitCode = $null
    if (-not $timedOut) { $exitCode = $process.ExitCode }

    return [ordered]@{
        filePath = $FilePath
        arguments = @($Arguments)
        commandLine = $FilePath + " " + $psi.Arguments
        timedOut = $timedOut
        timeoutMs = $TimeoutMs
        exitCode = $exitCode
        stdout = $stdout
        stderr = $stderr
    }
}

function Write-Utf8JsonFile {
    param([string]$Path, $Value, [int]$Depth = 20)
    [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth $Depth), (New-Object System.Text.UTF8Encoding($false)))
}

function Get-SandboxJobPaths {
    param([string]$JobId)

    $jobRoot = Join-Path $JobsDir $JobId
    return [ordered]@{
        root = $jobRoot
        metadata = Join-Path $jobRoot "metadata.json"
        command = Join-Path $jobRoot "command.ps1"
        wrapper = Join-Path $jobRoot "wrapper.ps1"
        result = Join-Path $jobRoot "result.json"
        stdout = Join-Path $jobRoot "stdout.log"
        stderr = Join-Path $jobRoot "stderr.log"
    }
}

function Stop-ProcessTree {
    param([int]$ProcessId)
    try { & taskkill.exe /PID $ProcessId /T /F | Out-Null }
    catch {
        try {
            $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
            if ($p) { $p.Kill() }
        }
        catch { }
    }
}

function Get-TextTail {
    param([string]$Path, [int]$TailLines = 80)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @((Get-Content -LiteralPath $Path -Tail $TailLines -ErrorAction SilentlyContinue))
}

function Start-SandboxPowerShellJob {
    param(
        [string]$Command,
        [int]$TimeoutMs = 600000,
        [string]$WorkingDirectory = ""
    )

    if (-not $Command) { throw "Command is required." }
    $jobId = [guid]::NewGuid().ToString()
    $paths = Get-SandboxJobPaths -JobId $jobId
    New-Item -ItemType Directory -Force -Path $paths.root | Out-Null
    [System.IO.File]::WriteAllText($paths.command, $Command, (New-Object System.Text.UTF8Encoding($false)))

    $wrapper = @'
param(
    [string]$CommandPath,
    [string]$ResultPath
)
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$started = Get-Date
$exitCode = 0
$errorMessage = $null
try {
    $command = Get-Content -LiteralPath $CommandPath -Raw
    $wrapped = '$ProgressPreference = "SilentlyContinue"; & { ' + $command + ' }; if ($null -ne $global:LASTEXITCODE) { exit $global:LASTEXITCODE }'
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($wrapped))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded
    if ($null -ne $global:LASTEXITCODE) { $exitCode = $global:LASTEXITCODE }
}
catch {
    $errorMessage = $_.Exception.Message
    if ($null -ne $global:LASTEXITCODE) { $exitCode = $global:LASTEXITCODE }
    else { $exitCode = 1 }
}
$result = [ordered]@{
    status = "completed"
    startedAt = $started.ToString("o")
    finishedAt = (Get-Date).ToString("o")
    timedOut = $false
    cancelled = $false
    exitCode = $exitCode
    error = $errorMessage
}
[System.IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
exit $exitCode
'@
    [System.IO.File]::WriteAllText($paths.wrapper, $wrapper, (New-Object System.Text.UTF8Encoding($false)))

    $resolvedWorkingDirectory = ""
    if ($WorkingDirectory) {
        if (-not (Test-Path -LiteralPath $WorkingDirectory)) { throw "workingDirectory does not exist: $WorkingDirectory" }
        $resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
    }

    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $paths.wrapper,
        "-CommandPath", $paths.command,
        "-ResultPath", $paths.result
    )
    $startInfo = @{
        FilePath = "powershell.exe"
        ArgumentList = $arguments
        PassThru = $true
        WindowStyle = "Hidden"
        RedirectStandardOutput = $paths.stdout
        RedirectStandardError = $paths.stderr
    }
    if ($resolvedWorkingDirectory) { $startInfo.WorkingDirectory = $resolvedWorkingDirectory }
    $process = Start-Process @startInfo
    $metadata = [ordered]@{
        jobId = $jobId
        type = "powershell"
        command = $Command
        pid = $process.Id
        startedAt = (Get-Date).ToString("o")
        timeoutMs = $TimeoutMs
        workingDirectory = $resolvedWorkingDirectory
        paths = [ordered]@{
            root = $paths.root
            result = $paths.result
            stdout = $paths.stdout
            stderr = $paths.stderr
        }
    }
    Write-Utf8JsonFile -Path $paths.metadata -Value $metadata
    return (Get-SandboxJobStatus -JobId $jobId -TailLines 20)
}

function Get-SandboxJobStatus {
    param([string]$JobId, [int]$TailLines = 80)

    if (-not $JobId) { throw "jobId is required." }
    $paths = Get-SandboxJobPaths -JobId $JobId
    if (-not (Test-Path -LiteralPath $paths.metadata)) { throw "Unknown jobId: $JobId" }
    $metadata = Get-Content -LiteralPath $paths.metadata -Raw | ConvertFrom-Json
    $result = $null
    if (Test-Path -LiteralPath $paths.result) {
        try {
            $result = Get-Content -LiteralPath $paths.result -Raw | ConvertFrom-Json
        }
        catch {
            $result = [ordered]@{
                status = "running"
                startedAt = $metadata.startedAt
                finishedAt = $null
                timedOut = $false
                cancelled = $false
                exitCode = $null
                error = "Result file is not readable yet."
            }
        }
    }
    else {
        $process = Get-Process -Id ([int]$metadata.pid) -ErrorAction SilentlyContinue
        $started = [datetime]$metadata.startedAt
        $elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
        if ($process -and $metadata.timeoutMs -gt 0 -and $elapsedMs -gt [int]$metadata.timeoutMs) {
            Stop-ProcessTree -ProcessId ([int]$metadata.pid)
            $result = [ordered]@{
                status = "timedOut"
                startedAt = $metadata.startedAt
                finishedAt = (Get-Date).ToString("o")
                timedOut = $true
                cancelled = $false
                exitCode = $null
                error = "Job exceeded timeoutMs."
            }
            Write-Utf8JsonFile -Path $paths.result -Value $result
        }
        elseif ($process) {
            $result = [ordered]@{
                status = "running"
                startedAt = $metadata.startedAt
                finishedAt = $null
                timedOut = $false
                cancelled = $false
                exitCode = $null
                error = $null
            }
        }
        else {
            $result = [ordered]@{
                status = "unknown"
                startedAt = $metadata.startedAt
                finishedAt = (Get-Date).ToString("o")
                timedOut = $false
                cancelled = $false
                exitCode = $null
                error = "Process exited without writing a result file."
            }
            Write-Utf8JsonFile -Path $paths.result -Value $result
        }
    }

    return [ordered]@{
        jobId = $JobId
        type = $metadata.type
        command = $metadata.command
        pid = $metadata.pid
        timeoutMs = $metadata.timeoutMs
        workingDirectory = $metadata.workingDirectory
        status = $result.status
        timedOut = $result.timedOut
        cancelled = $result.cancelled
        exitCode = $result.exitCode
        error = $result.error
        startedAt = $result.startedAt
        finishedAt = $result.finishedAt
        stdoutTail = @(Get-TextTail -Path $paths.stdout -TailLines $TailLines)
        stderrTail = @(Get-TextTail -Path $paths.stderr -TailLines $TailLines)
        paths = [ordered]@{
            root = $paths.root
            result = $paths.result
            stdout = $paths.stdout
            stderr = $paths.stderr
            bridgeRelativePath = ConvertTo-BridgeRelativePath -Path $paths.root
        }
    }
}

function Stop-SandboxJob {
    param([string]$JobId)

    if (-not $JobId) { throw "jobId is required." }
    $paths = Get-SandboxJobPaths -JobId $JobId
    if (-not (Test-Path -LiteralPath $paths.metadata)) { throw "Unknown jobId: $JobId" }
    $metadata = Get-Content -LiteralPath $paths.metadata -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $paths.result)) {
        Stop-ProcessTree -ProcessId ([int]$metadata.pid)
        $result = [ordered]@{
            status = "cancelled"
            startedAt = $metadata.startedAt
            finishedAt = (Get-Date).ToString("o")
            timedOut = $false
            cancelled = $true
            exitCode = $null
            error = "Cancelled by sandbox_job_cancel."
        }
        Write-Utf8JsonFile -Path $paths.result -Value $result
    }
    return Get-SandboxJobStatus -JobId $JobId
}

function Get-IntuneToolVersion {
    param([string]$ToolPath)

    if (-not (Test-Path -LiteralPath $ToolPath)) { return $null }
    try {
        $result = Invoke-CapturedProcess -FilePath $ToolPath -Arguments @("-v") -TimeoutMs 15000
        $text = (($result.stdout + "`n" + $result.stderr) -replace '\s+', ' ').Trim()
        if ($text.Length -gt 300) { $text = $text.Substring(0, 300) }
        return $text
    }
    catch {
        return $null
    }
}

function Resolve-IntuneWinAppUtil {
    param(
        [string]$ToolPath = "",
        [bool]$EnsureTool = $true,
        [string]$DownloadUrl = ""
    )

    $defaultUrl = "https://raw.githubusercontent.com/microsoft/Microsoft-Win32-Content-Prep-Tool/master/IntuneWinAppUtil.exe"
    if (-not $DownloadUrl) { $DownloadUrl = $defaultUrl }

    $searched = New-Object System.Collections.ArrayList
    $downloaded = $false
    $chosen = $null
    $candidates = @()
    if ($ToolPath) { $candidates += $ToolPath }
    $candidates += (Join-Path $ToolsDir "IntuneWinAppUtil.exe")
    $candidates += (Join-Path (Get-DefaultDownloadsPath) "IntuneWinAppUtil.exe")
    $candidates += (Join-Path $env:TEMP "IntuneWinAppUtil.exe")

    foreach ($candidate in $candidates) {
        [void]$searched.Add($candidate)
        if (Test-Path -LiteralPath $candidate) {
            $chosen = (Resolve-Path -LiteralPath $candidate).Path
            break
        }
    }

    if (-not $chosen -and $EnsureTool) {
        if ($DownloadUrl -notmatch '^https://(raw\.githubusercontent\.com|github\.com)/microsoft/Microsoft-Win32-Content-Prep-Tool/') {
            throw "Refusing to auto-download IntuneWinAppUtil.exe from a non-Microsoft GitHub URL: $DownloadUrl"
        }
        $chosen = Join-Path $ToolsDir "IntuneWinAppUtil.exe"
        $tmp = $chosen + ".download"
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        }
        catch { }
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $tmp -UseBasicParsing
        Move-Item -Force -LiteralPath $tmp -Destination $chosen
        $downloaded = $true
    }

    if (-not $chosen) {
        return [ordered]@{
            available = $false
            path = $null
            bridgeRelativePath = $null
            downloaded = $false
            searched = @($searched)
            downloadUrl = $DownloadUrl
            version = $null
            licenseNote = "Download and use of IntuneWinAppUtil.exe is governed by Microsoft's Win32 Content Prep Tool license terms."
        }
    }

    return [ordered]@{
        available = $true
        path = $chosen
        bridgeRelativePath = ConvertTo-BridgeRelativePath -Path $chosen
        downloaded = $downloaded
        searched = @($searched)
        downloadUrl = $(if ($downloaded) { $DownloadUrl } else { $null })
        version = Get-IntuneToolVersion -ToolPath $chosen
        licenseNote = "Download and use of IntuneWinAppUtil.exe is governed by Microsoft's Win32 Content Prep Tool license terms."
    }
}

function Resolve-SetupFileForIntune {
    param([string]$SourceFolder, [string]$SetupFile)

    if (-not $SetupFile) { throw "setupFile is required." }
    $source = (Resolve-Path -LiteralPath $SourceFolder).Path
    $setupPath = $SetupFile
    if (-not [System.IO.Path]::IsPathRooted($setupPath)) {
        $setupPath = Join-Path $source $setupPath
    }
    if (-not (Test-Path -LiteralPath $setupPath)) { throw "Setup file does not exist: $setupPath" }
    $resolvedSetup = (Resolve-Path -LiteralPath $setupPath).Path
    if (-not $resolvedSetup.StartsWith($source.TrimEnd('\') + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "setupFile must be inside sourceFolder so IntuneWinAppUtil can package it."
    }
    return [ordered]@{
        path = $resolvedSetup
        relative = $resolvedSetup.Substring($source.TrimEnd('\').Length + 1)
        file = [System.IO.Path]::GetFileName($resolvedSetup)
        extension = [System.IO.Path]::GetExtension($resolvedSetup).ToLowerInvariant()
    }
}

function Get-IntunePackagingMetadata {
    param(
        [string]$SetupPath,
        [string]$InstallCommand = "",
        [string]$UninstallCommand = ""
    )

    $extension = [System.IO.Path]::GetExtension($SetupPath).ToLowerInvariant()
    $detection = $null
    $suggestedInstall = $InstallCommand
    $suggestedUninstall = $UninstallCommand
    $returnCodes = @(
        [ordered]@{ code = 0; type = "success" },
        [ordered]@{ code = 1707; type = "success" },
        [ordered]@{ code = 3010; type = "softReboot" },
        [ordered]@{ code = 1641; type = "hardReboot" },
        [ordered]@{ code = 1618; type = "retry" }
    )

    if ($extension -eq ".msi") {
        try {
            $msi = Get-MsiInfo -Path $SetupPath
            if (-not $suggestedInstall) {
                $suggestedInstall = "msiexec /i " + (ConvertTo-InstallerCommandLiteral ([System.IO.Path]::GetFileName($SetupPath))) + " /qn /norestart"
            }
            if (-not $suggestedUninstall -and $msi.productCode) {
                $suggestedUninstall = "msiexec /x " + $msi.productCode + " /qn /norestart"
            }
            $detection = [ordered]@{
                type = "msiProductCode"
                productCode = $msi.productCode
                productVersion = $msi.productVersion
                productName = $msi.productName
                rule = "Use MSI product code detection in Intune."
            }
        }
        catch {
            $detection = [ordered]@{ type = "msi"; error = $_.Exception.Message }
        }
    }
    else {
        if (-not $suggestedInstall) {
            $suggestedInstall = (ConvertTo-InstallerCommandLiteral ([System.IO.Path]::GetFileName($SetupPath))) + " /quiet /norestart"
        }
        $detection = [ordered]@{
            type = "registryOrFile"
            rule = "EXE installers need an app-specific detection rule. Prefer the uninstall registry key after a test install; fall back to a versioned file path."
        }
    }

    return [ordered]@{
        installCommand = $suggestedInstall
        uninstallCommand = $suggestedUninstall
        detection = $detection
        returnCodes = @($returnCodes)
    }
}

function Test-VersionAtLeast {
    param([string]$Actual, [string]$Minimum)

    if (-not $Minimum) { return $true }
    if (-not $Actual) { return $false }
    try { return ([version]$Actual -ge [version]$Minimum) }
    catch { return ($Actual -ge $Minimum) }
}

function Test-MsiProductDetection {
    param([string]$ProductCode, [string]$ProductVersion = "")

    $registryPaths = @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    # NB: do not name this $matches - that is a PowerShell automatic variable populated by -match.
    $found = foreach ($path in $registryPaths) {
        Get-ItemProperty -Path $path -ErrorAction SilentlyContinue |
            Where-Object {
                ($_.PSChildName -eq $ProductCode) -or
                ($_.UninstallString -and ([string]$_.UninstallString).IndexOf($ProductCode, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
            } |
            Select-Object PSPath, PSChildName, DisplayName, DisplayVersion, Publisher, UninstallString
    }
    $found = @($found)
    $versionOk = $true
    if ($ProductVersion -and $found.Count -gt 0) {
        $versionOk = $false
        foreach ($entry in $found) {
            if ([string]$entry.DisplayVersion -eq $ProductVersion) { $versionOk = $true; break }
        }
    }
    return [ordered]@{
        detected = (($found.Count -gt 0) -and $versionOk)
        matchCount = $found.Count
        matches = @($found)
        versionOk = $versionOk
    }
}

function Test-RegistryDetection {
    param($Rule)

    $path = [string](Get-ObjectPropertyValue -Object $Rule -Name "path" "")
    if (-not $path) { throw "registry detection requires path." }
    $exists = Test-Path -LiteralPath $path
    $valueName = [string](Get-ObjectPropertyValue -Object $Rule -Name "valueName" "")
    if (-not $exists -or -not $valueName) {
        return [ordered]@{ detected = $exists; path = $path; valueName = $valueName; value = $null }
    }

    $value = Get-ObjectPropertyValue -Object (Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue) -Name $valueName
    $operator = [string](Get-ObjectPropertyValue -Object $Rule -Name "operator" "exists")
    $expected = Get-ObjectPropertyValue -Object $Rule -Name "value"
    $detected = $false
    switch ($operator) {
        "equals" { $detected = ([string]$value -eq [string]$expected) }
        "contains" { $detected = ([string]$value).IndexOf([string]$expected, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
        "notEquals" { $detected = ([string]$value -ne [string]$expected) }
        default { $detected = ($null -ne $value) }
    }
    return [ordered]@{ detected = $detected; path = $path; valueName = $valueName; operator = $operator; expected = $expected; value = $value }
}

function Test-FileDetection {
    param($Rule)

    $path = [string](Get-ObjectPropertyValue -Object $Rule -Name "path" "")
    if (-not $path) { throw "file detection requires path." }
    $exists = Test-Path -LiteralPath $path
    if (-not $exists) {
        return [ordered]@{ detected = $false; path = $path; exists = $false }
    }
    $item = Get-Item -LiteralPath $path
    $fileVersion = $null
    try { $fileVersion = $item.VersionInfo.FileVersion } catch { }
    $productVersion = $null
    try { $productVersion = $item.VersionInfo.ProductVersion } catch { }
    $minVersion = [string](Get-ObjectPropertyValue -Object $Rule -Name "minVersion" "")
    $version = [string](Get-ObjectPropertyValue -Object $Rule -Name "version" "")
    $versionOk = $true
    if ($version) { $versionOk = (($fileVersion -eq $version) -or ($productVersion -eq $version)) }
    elseif ($minVersion) { $versionOk = ((Test-VersionAtLeast -Actual $fileVersion -Minimum $minVersion) -or (Test-VersionAtLeast -Actual $productVersion -Minimum $minVersion)) }
    return [ordered]@{
        detected = ($exists -and $versionOk)
        path = $item.FullName
        exists = $exists
        fileVersion = $fileVersion
        productVersion = $productVersion
        minVersion = $minVersion
        version = $version
        versionOk = $versionOk
    }
}

function Test-ScriptDetection {
    param($Rule, [int]$TimeoutMs = 30000)

    $script = [string](Get-ObjectPropertyValue -Object $Rule -Name "script" "")
    if (-not $script) { $script = [string](Get-ObjectPropertyValue -Object $Rule -Name "command" "") }
    if (-not $script) { throw "script detection requires script or command." }
    $result = Invoke-InstallerCommandTest -Command $script -TimeoutMs $TimeoutMs
    return [ordered]@{
        detected = ((-not $result.timedOut) -and ($result.exitCode -eq 0))
        exitCode = $result.exitCode
        timedOut = $result.timedOut
        stdout = $result.stdout
        stderr = $result.stderr
    }
}

function Test-DetectionRule {
    param(
        $Rule,
        [bool]$ExpectedPresent = $true,
        [int]$TimeoutMs = 30000
    )

    if (-not $Rule) {
        return [ordered]@{
            skipped = $true
            reason = "No detection rule was provided."
            expectedPresent = $ExpectedPresent
            passed = $false
        }
    }

    $type = [string](Get-ObjectPropertyValue -Object $Rule -Name "type" "")
    if (-not $type) { throw "detection rule requires type." }
    $evidence = $null
    switch ($type) {
        "msiProductCode" {
            $productCode = [string](Get-ObjectPropertyValue -Object $Rule -Name "productCode" "")
            if (-not $productCode) { throw "msiProductCode detection requires productCode." }
            $productVersion = [string](Get-ObjectPropertyValue -Object $Rule -Name "productVersion" "")
            $evidence = Test-MsiProductDetection -ProductCode $productCode -ProductVersion $productVersion
        }
        "registry" { $evidence = Test-RegistryDetection -Rule $Rule }
        "file" { $evidence = Test-FileDetection -Rule $Rule }
        "script" { $evidence = Test-ScriptDetection -Rule $Rule -TimeoutMs $TimeoutMs }
        default { throw "Unsupported detection rule type: $type" }
    }

    $detected = [bool](Get-ObjectPropertyValue -Object $evidence -Name "detected" $false)
    return [ordered]@{
        type = $type
        expectedPresent = $ExpectedPresent
        detected = $detected
        passed = $(if ($ExpectedPresent) { $detected } else { -not $detected })
        evidence = $evidence
    }
}

function Test-ProcessAssertion {
    param($Assertion)

    $name = [string](Get-ObjectPropertyValue -Object $Assertion -Name "name" "")
    if (-not $name) { throw "process assertion requires name." }
    $bare = $name -replace '\.exe$', ''
    $procs = @(Get-Process -Name $bare -ErrorAction SilentlyContinue | Select-Object Id, ProcessName)
    return [ordered]@{
        detected = ($procs.Count -gt 0)
        name = $name
        matchCount = $procs.Count
        matches = @($procs)
    }
}

function Test-ServiceAssertion {
    param($Assertion)

    $name = [string](Get-ObjectPropertyValue -Object $Assertion -Name "name" "")
    if (-not $name) { throw "service assertion requires name." }
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $service) {
        return [ordered]@{ detected = $false; name = $name; exists = $false; status = $null }
    }
    $expectedStatus = [string](Get-ObjectPropertyValue -Object $Assertion -Name "status" "")
    $actualStatus = [string]$service.Status
    $statusOk = $true
    if ($expectedStatus) { $statusOk = ($actualStatus -eq $expectedStatus) }
    return [ordered]@{
        detected = $statusOk
        name = $name
        exists = $true
        status = $actualStatus
        expectedStatus = $expectedStatus
        statusOk = $statusOk
    }
}

function Test-WindowAssertion {
    param($Assertion)

    $title = [string](Get-ObjectPropertyValue -Object $Assertion -Name "title" "")
    if (-not $title) { $title = [string](Get-ObjectPropertyValue -Object $Assertion -Name "name" "") }
    if (-not $title) { throw "window assertion requires title." }
    $match = [string](Get-ObjectPropertyValue -Object $Assertion -Name "match" "contains")
    $windows = @(Get-TopLevelWindows)
    $hit = @($windows | Where-Object {
        if ($match -eq "exact") { [string]$_.name -eq $title }
        else { ([string]$_.name).IndexOf($title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
    })
    return [ordered]@{
        detected = ($hit.Count -gt 0)
        title = $title
        match = $match
        matchCount = $hit.Count
        matches = @($hit)
    }
}

function Test-InstalledProgramAssertion {
    param($Assertion)

    $name = [string](Get-ObjectPropertyValue -Object $Assertion -Name "name" "")
    if (-not $name) { throw "installedProgram assertion requires name." }
    $minVersion = [string](Get-ObjectPropertyValue -Object $Assertion -Name "minVersion" "")
    $registryPaths = @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    $found = foreach ($path in $registryPaths) {
        Get-ItemProperty -Path $path -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -and ([string]$_.DisplayName).IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
            Select-Object DisplayName, DisplayVersion, Publisher
    }
    $found = @($found)
    $versionOk = $true
    if ($minVersion -and $found.Count -gt 0) {
        $versionOk = $false
        foreach ($entry in $found) {
            if (Test-VersionAtLeast -Actual ([string]$entry.DisplayVersion) -Minimum $minVersion) { $versionOk = $true; break }
        }
    }
    return [ordered]@{
        detected = (($found.Count -gt 0) -and $versionOk)
        name = $name
        minVersion = $minVersion
        matchCount = $found.Count
        matches = @($found)
        versionOk = $versionOk
    }
}

function Test-Assertion {
    # Single assertion. Detection-style types (file/registry/msiProductCode/script) reuse the
    # detection engine; process/service/window/installedProgram are evaluated here. Returns a
    # normalized record whose 'passed' honors expectedPresent (default true).
    param(
        $Assertion,
        [int]$TimeoutMs = 30000
    )

    if (-not $Assertion) { throw "assertion is required." }
    $type = [string](Get-ObjectPropertyValue -Object $Assertion -Name "type" "")
    if (-not $type) { throw "assertion requires type." }
    $label = [string](Get-ObjectPropertyValue -Object $Assertion -Name "label" "")
    $expectedPresent = [bool](Get-ObjectPropertyValue -Object $Assertion -Name "expectedPresent" $true)

    switch ($type) {
        { @("file", "registry", "msiProductCode", "script") -contains $_ } {
            $result = Test-DetectionRule -Rule $Assertion -ExpectedPresent $expectedPresent -TimeoutMs $TimeoutMs
            if (-not $label) { $label = $type }
            return [ordered]@{
                type = $type
                label = $label
                expectedPresent = $expectedPresent
                detected = $result.detected
                passed = $result.passed
                evidence = $result.evidence
            }
        }
        "process" { $evidence = Test-ProcessAssertion -Assertion $Assertion }
        "service" { $evidence = Test-ServiceAssertion -Assertion $Assertion }
        "window" { $evidence = Test-WindowAssertion -Assertion $Assertion }
        "installedProgram" { $evidence = Test-InstalledProgramAssertion -Assertion $Assertion }
        default { throw "Unsupported assertion type: $type" }
    }

    $detected = [bool](Get-ObjectPropertyValue -Object $evidence -Name "detected" $false)
    if (-not $label) { $label = $type }
    return [ordered]@{
        type = $type
        label = $label
        expectedPresent = $expectedPresent
        detected = $detected
        passed = $(if ($expectedPresent) { $detected } else { -not $detected })
        evidence = $evidence
    }
}

function Invoke-AssertionSet {
    # Evaluate an array of assertions and roll up pass/fail.
    param($Assertions, [int]$TimeoutMs = 30000)

    $list = @($Assertions)
    if ($list.Count -eq 0) { throw "assert requires a non-empty 'assertions' array." }
    $results = foreach ($assertion in $list) { Test-Assertion -Assertion $assertion -TimeoutMs $TimeoutMs }
    $results = @($results)
    $failed = @($results | Where-Object { -not $_.passed })
    return [ordered]@{
        passed = ($failed.Count -eq 0)
        total = $results.Count
        passedCount = ($results.Count - $failed.Count)
        failedCount = $failed.Count
        results = @($results)
    }
}

function Test-PackagingDetectionRule {
    param(
        $Rule,
        [bool]$ExpectedPresent = $true,
        [int]$TimeoutMs = 30000
    )

    if (-not $Rule) {
        return [ordered]@{ skipped = $true; passed = $true; reason = "No concrete detection rule was available."; expectedPresent = $ExpectedPresent }
    }
    $type = [string](Get-ObjectPropertyValue -Object $Rule -Name "type" "")
    if (@("msiProductCode", "registry", "file", "script") -notcontains $type) {
        return [ordered]@{
            skipped = $true
            passed = $true
            reason = "Detection rule type '$type' is a placeholder or is not supported for automated verification."
            expectedPresent = $ExpectedPresent
        }
    }
    return Test-DetectionRule -Rule $Rule -ExpectedPresent $ExpectedPresent -TimeoutMs $TimeoutMs
}

function New-PackagingFailure {
    # Shared shape for every "package creation was skipped" early return in Invoke-IntuneWin32Package,
    # so the field set stays in one place.
    param(
        [string]$SourceFolder,
        [string]$SetupFile,
        [string]$OutputFolder,
        $Metadata,
        $InstallTest = $null,
        $DetectionAfterInstall = $null,
        $UninstallTest = $null,
        $DetectionAfterUninstall = $null,
        [string]$Warning
    )
    return [ordered]@{
        sourceFolder = $SourceFolder
        setupFile = $SetupFile
        outputFolder = $OutputFolder
        tool = $null
        process = $null
        succeeded = $false
        packages = @()
        metadata = $Metadata
        installTest = $InstallTest
        detectionAfterInstall = $DetectionAfterInstall
        uninstallTest = $UninstallTest
        detectionAfterUninstall = $DetectionAfterUninstall
        warning = $Warning
    }
}

function Invoke-IntuneWin32Package {
    param(
        [string]$SourceFolder,
        [string]$SetupFile,
        [string]$OutputFolder = "",
        [string]$InstallCommand = "",
        [string]$UninstallCommand = "",
        $DetectionRule = $null,
        [string]$ToolPath = "",
        [bool]$EnsureTool = $true,
        [string]$DownloadUrl = "",
        [bool]$Quiet = $true,
        [bool]$IncludeCatalog = $false,
        [int]$TimeoutMs = 300000,
        [bool]$TestInstall = $true,
        [int]$InstallTestTimeoutMs = 90000,
        [bool]$VerifyDetection = $true,
        [bool]$TestUninstall = $true,
        [int]$UninstallTestTimeoutMs = 90000
    )

    if (-not $SourceFolder) { throw "sourceFolder is required." }
    if (-not (Test-Path -LiteralPath $SourceFolder)) { throw "sourceFolder does not exist: $SourceFolder" }
    $resolvedSource = (Resolve-Path -LiteralPath $SourceFolder).Path
    if (-not $OutputFolder) { $OutputFolder = $IntuneArtifactsDir }
    New-Item -ItemType Directory -Force -Path $OutputFolder | Out-Null
    $resolvedOutput = (Resolve-Path -LiteralPath $OutputFolder).Path
    $setup = Resolve-SetupFileForIntune -SourceFolder $resolvedSource -SetupFile $SetupFile
    $metadata = Get-IntunePackagingMetadata -SetupPath $setup.path -InstallCommand $InstallCommand -UninstallCommand $UninstallCommand
    $effectiveDetectionRule = $DetectionRule
    if (-not $effectiveDetectionRule) { $effectiveDetectionRule = $metadata.detection }

    $installTest = $null
    $detectionAfterInstall = $null
    $uninstallTest = $null
    $detectionAfterUninstall = $null
    if ($TestInstall) {
        if (-not $metadata.installCommand) {
            return New-PackagingFailure -SourceFolder $resolvedSource -SetupFile $setup.relative -OutputFolder $resolvedOutput -Metadata $metadata `
                -InstallTest ([ordered]@{ skipped = $true; reason = "No install command was provided or inferred, so the package was not created." }) `
                -Warning "Install test was required but no install command was available."
        }

        $installTest = Invoke-InstallerCommandTest -Command $metadata.installCommand -TimeoutMs $InstallTestTimeoutMs -WorkingDirectory $resolvedSource
        $successExitCodes = @(0, 1707, 3010, 1641)
        $installTestPassed = ((-not $installTest.timedOut) -and ($null -ne $installTest.exitCode) -and ($successExitCodes -contains [int]$installTest.exitCode))
        if (-not $installTestPassed) {
            return New-PackagingFailure -SourceFolder $resolvedSource -SetupFile $setup.relative -OutputFolder $resolvedOutput -Metadata $metadata `
                -InstallTest $installTest `
                -Warning "Install test failed or timed out; Intune package creation was skipped."
        }
        if ($VerifyDetection) {
            $detectionAfterInstall = Test-PackagingDetectionRule -Rule $effectiveDetectionRule -ExpectedPresent $true
            if (-not $detectionAfterInstall.passed) {
                return New-PackagingFailure -SourceFolder $resolvedSource -SetupFile $setup.relative -OutputFolder $resolvedOutput -Metadata $metadata `
                    -InstallTest $installTest -DetectionAfterInstall $detectionAfterInstall `
                    -Warning "Detection rule did not match after install; Intune package creation was skipped."
            }
        }
        else {
            $detectionAfterInstall = [ordered]@{ skipped = $true; reason = "verifyDetection was set to false." }
        }

        if ($TestUninstall) {
            if (-not $metadata.uninstallCommand) {
                $uninstallTest = [ordered]@{ skipped = $true; reason = "No uninstall command was provided or inferred." }
            }
            else {
                $uninstallTest = Invoke-InstallerCommandTest -Command $metadata.uninstallCommand -TimeoutMs $UninstallTestTimeoutMs -WorkingDirectory $resolvedSource
                $successExitCodes = @(0, 1605, 1707, 3010, 1641)
                $uninstallTestPassed = ((-not $uninstallTest.timedOut) -and ($null -ne $uninstallTest.exitCode) -and ($successExitCodes -contains [int]$uninstallTest.exitCode))
                if (-not $uninstallTestPassed) {
                    return New-PackagingFailure -SourceFolder $resolvedSource -SetupFile $setup.relative -OutputFolder $resolvedOutput -Metadata $metadata `
                        -InstallTest $installTest -DetectionAfterInstall $detectionAfterInstall -UninstallTest $uninstallTest `
                        -Warning "Uninstall test failed or timed out; Intune package creation was skipped."
                }
                if ($VerifyDetection) {
                    $detectionAfterUninstall = Test-PackagingDetectionRule -Rule $effectiveDetectionRule -ExpectedPresent $false
                    if (-not $detectionAfterUninstall.passed) {
                        return New-PackagingFailure -SourceFolder $resolvedSource -SetupFile $setup.relative -OutputFolder $resolvedOutput -Metadata $metadata `
                            -InstallTest $installTest -DetectionAfterInstall $detectionAfterInstall -UninstallTest $uninstallTest -DetectionAfterUninstall $detectionAfterUninstall `
                            -Warning "Detection rule still matched after uninstall; Intune package creation was skipped."
                    }
                }
                else {
                    $detectionAfterUninstall = [ordered]@{ skipped = $true; reason = "verifyDetection was set to false." }
                }
            }
        }
        else {
            $uninstallTest = [ordered]@{ skipped = $true; reason = "testUninstall was set to false." }
        }
    }
    else {
        $installTest = [ordered]@{ skipped = $true; reason = "testInstall was set to false." }
        $detectionAfterInstall = [ordered]@{ skipped = $true; reason = "testInstall was set to false." }
        $uninstallTest = [ordered]@{ skipped = $true; reason = "testInstall was set to false." }
        $detectionAfterUninstall = [ordered]@{ skipped = $true; reason = "testInstall was set to false." }
    }

    $tool = Resolve-IntuneWinAppUtil -ToolPath $ToolPath -EnsureTool $EnsureTool -DownloadUrl $DownloadUrl
    if (-not $tool.available) { throw "IntuneWinAppUtil.exe was not found. Pass ensureTool=true to download it or provide toolPath." }

    $sourceRoot = [System.IO.Path]::GetFullPath($resolvedSource).TrimEnd('\')
    $toolRoot = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($tool.path)).TrimEnd('\')
    if ($toolRoot.StartsWith($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "IntuneWinAppUtil.exe is inside sourceFolder. Move it outside the source folder so it is not included in the package."
    }
    $outputRoot = [System.IO.Path]::GetFullPath($resolvedOutput).TrimEnd('\')
    if ($outputRoot.StartsWith($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "outputFolder is inside sourceFolder. Choose an output folder outside the source folder so generated packages are not included."
    }

    $started = Get-Date
    $arguments = @("-c", $resolvedSource, "-s", $setup.relative, "-o", $resolvedOutput)
    if ($Quiet) { $arguments += "-q" }
    if ($IncludeCatalog) { $arguments += "-a" }
    $process = Invoke-CapturedProcess -FilePath $tool.path -Arguments $arguments -TimeoutMs $TimeoutMs
    $packages = @(Get-ChildItem -LiteralPath $resolvedOutput -Filter *.intunewin -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $started.AddSeconds(-2) } |
            Sort-Object LastWriteTime -Descending |
            ForEach-Object {
                [ordered]@{
                    guestPath = $_.FullName
                    bridgeRelativePath = ConvertTo-BridgeRelativePath -Path $_.FullName
                    file = $_.Name
                    size = $_.Length
                    lastWriteTime = $_.LastWriteTime.ToString("o")
                }
            })
    return [ordered]@{
        sourceFolder = $resolvedSource
        setupFile = $setup.relative
        outputFolder = $resolvedOutput
        tool = $tool
        process = $process
        succeeded = ((-not $process.timedOut) -and ($process.exitCode -eq 0) -and ($packages.Count -gt 0))
        packages = @($packages)
        metadata = $metadata
        installTest = $installTest
        detectionAfterInstall = $detectionAfterInstall
        uninstallTest = $uninstallTest
        detectionAfterUninstall = $detectionAfterUninstall
        warning = $(if ($packages.Count -eq 0) { "No .intunewin file was found in the output folder after packaging." } else { $null })
    }
}

function Invoke-MouseClick {
    param(
        [int]$X,
        [int]$Y,
        [string]$Button = "left"
    )

    [SandboxInput]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 100

    switch ($Button.ToLowerInvariant()) {
        "right" {
            [SandboxInput]::mouse_event([SandboxInput]::RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            [SandboxInput]::mouse_event([SandboxInput]::RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
        }
        "middle" {
            [SandboxInput]::mouse_event([SandboxInput]::MIDDLEDOWN, 0, 0, 0, [UIntPtr]::Zero)
            [SandboxInput]::mouse_event([SandboxInput]::MIDDLEUP, 0, 0, 0, [UIntPtr]::Zero)
        }
        default {
            [SandboxInput]::mouse_event([SandboxInput]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            [SandboxInput]::mouse_event([SandboxInput]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        }
    }
}

function Center-ForegroundWindow {
    $handle = [SandboxInput]::GetForegroundWindow()
    if ($handle -eq [IntPtr]::Zero) {
        throw "No foreground window found."
    }

    $rect = New-Object SandboxInput+RECT
    if (-not [SandboxInput]::GetWindowRect($handle, [ref]$rect)) {
        throw "Could not read foreground window bounds."
    }

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    $x = [Math]::Max($screen.Left, [int]($screen.Left + (($screen.Width - $width) / 2)))
    $y = [Math]::Max($screen.Top, [int]($screen.Top + (($screen.Height - $height) / 2)))

    [SandboxInput]::SetWindowPos($handle, [IntPtr]::Zero, $x, $y, $width, $height, [SandboxInput]::SWP_NOZORDER -bor [SandboxInput]::SWP_SHOWWINDOW) | Out-Null

    [pscustomobject]@{
        x = $x
        y = $y
        width = $width
        height = $height
    }
}

function Get-ArgValue {
    param(
        $Bag,
        [string]$Name,
        $Default = $null
    )

    if ($null -ne $Bag -and $Bag.PSObject.Properties.Match($Name).Count -gt 0 -and $null -ne $Bag.$Name) {
        return $Bag.$Name
    }
    return $Default
}

function Get-UiTree {
    param(
        [string]$Scope = "window",
        [int]$MaxDepth = 12,
        [int]$MaxNodes = 400,
        [bool]$OnlyInteractive = $false
    )

    $auto = [System.Windows.Automation.AutomationElement]
    if ($Scope -eq "desktop") {
        $root = $auto::RootElement
    }
    else {
        $handle = [SandboxInput]::GetForegroundWindow()
        if ($handle -eq [IntPtr]::Zero) {
            $root = $auto::RootElement
        }
        else {
            $root = $auto::FromHandle($handle)
        }
    }

    if (-not $root) {
        throw "Could not resolve a UI Automation root element."
    }

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $valuePattern = [System.Windows.Automation.ValuePattern]::Pattern
    $interactivePatterns = @(
        [System.Windows.Automation.InvokePattern]::Pattern,
        [System.Windows.Automation.TogglePattern]::Pattern,
        $valuePattern,
        [System.Windows.Automation.SelectionItemPattern]::Pattern,
        [System.Windows.Automation.ExpandCollapsePattern]::Pattern
    )

    $nodes = New-Object System.Collections.ArrayList
    $truncated = $false

    $stack = New-Object System.Collections.Stack
    $stack.Push([pscustomobject]@{ element = $root; depth = 0 })

    while ($stack.Count -gt 0) {
        if ($nodes.Count -ge $MaxNodes) { $truncated = $true; break }

        $frame = $stack.Pop()
        $element = $frame.element
        $depth = $frame.depth

        $info = $null
        try { $info = $element.Current } catch { continue }

        $isInteractive = $false
        foreach ($p in $interactivePatterns) {
            $tmp = $null
            try {
                if ($element.TryGetCurrentPattern($p, [ref]$tmp)) { $isInteractive = $true; break }
            }
            catch { }
        }

        if ((-not $OnlyInteractive) -or $isInteractive) {
            $rect = $null
            $click = $null
            try {
                $r = $info.BoundingRectangle
                if (-not [double]::IsInfinity($r.X) -and $r.Width -gt 0 -and $r.Height -gt 0) {
                    $rect = @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
                    $click = @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
                }
            }
            catch { }

            $value = $null
            $vp = $null
            try {
                if ($element.TryGetCurrentPattern($valuePattern, [ref]$vp)) { $value = $vp.Current.Value }
            }
            catch { }

            $name = [string]$info.Name
            if ($name.Length -gt 200) { $name = $name.Substring(0, 200) + "..." }
            if ($value -and ([string]$value).Length -gt 500) { $value = ([string]$value).Substring(0, 500) + "..." }

            $node = [ordered]@{
                depth = $depth
                type = ($info.ControlType.ProgrammaticName -replace '^ControlType\.', '')
                name = $name
            }
            if ($info.AutomationId) { $node.id = $info.AutomationId }
            if ($rect) { $node.rect = $rect; $node.click = $click }
            if ($value) { $node.value = $value }
            if ($isInteractive) { $node.interactive = $true }
            if (-not $info.IsEnabled) { $node.enabled = $false }
            if ($info.IsOffscreen) { $node.offscreen = $true }

            [void]$nodes.Add($node)
        }

        if ($depth -lt $MaxDepth) {
            $childList = New-Object System.Collections.ArrayList
            try {
                $child = $walker.GetFirstChild($element)
                while ($child) {
                    [void]$childList.Add($child)
                    $child = $walker.GetNextSibling($child)
                }
            }
            catch { }

            for ($i = $childList.Count - 1; $i -ge 0; $i--) {
                $stack.Push([pscustomobject]@{ element = $childList[$i]; depth = ($depth + 1) })
            }
        }
    }

    return [ordered]@{
        scope = $Scope
        rootName = [string]$root.Current.Name
        nodeCount = $nodes.Count
        truncated = $truncated
        onlyInteractive = $OnlyInteractive
        nodes = @($nodes)
    }
}

function Resolve-UiRoot {
    param([string]$Scope = "window")
    $auto = [System.Windows.Automation.AutomationElement]
    if ($Scope -eq "desktop") { return $auto::RootElement }
    $handle = [SandboxInput]::GetForegroundWindow()
    if ($handle -eq [IntPtr]::Zero) { return $auto::RootElement }
    return $auto::FromHandle($handle)
}

# Find AutomationElements matching a selector (name / automationId / controlType, AND-ed).
# Returns elements in pre-order. Name match is case-insensitive; "contains" by default.
function Find-UiElements {
    param(
        $Root,
        [string]$Name = "",
        [string]$AutomationId = "",
        [string]$ControlType = "",
        [string]$Match = "contains",
        [int]$MaxScan = 3000
    )
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $matches = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    $stack.Push($Root)
    $scanned = 0

    while ($stack.Count -gt 0 -and $scanned -lt $MaxScan) {
        $el = $stack.Pop()
        $scanned++
        $info = $null
        try { $info = $el.Current } catch { continue }

        $ok = $true
        if ($Name) {
            $n = [string]$info.Name
            if ($Match -eq "exact") { if ($n -ne $Name) { $ok = $false } }
            elseif ($n -notlike "*$Name*") { $ok = $false }
        }
        if ($ok -and $AutomationId) { if ([string]$info.AutomationId -ne $AutomationId) { $ok = $false } }
        if ($ok -and $ControlType) {
            $ct = ($info.ControlType.ProgrammaticName -replace '^ControlType\.', '')
            if ($ct -ne $ControlType) { $ok = $false }
        }
        if ($ok) { [void]$matches.Add($el) }

        $children = New-Object System.Collections.ArrayList
        try {
            $child = $walker.GetFirstChild($el)
            while ($child) { [void]$children.Add($child); $child = $walker.GetNextSibling($child) }
        }
        catch { }
        for ($i = $children.Count - 1; $i -ge 0; $i--) { $stack.Push($children[$i]) }
    }
    return $matches.ToArray()
}

# Actuate an element through UI Automation patterns (no synthetic mouse), with an optional
# coordinate-click fallback for elements that expose no actionable pattern.
function Invoke-UiElement {
    param($Element, [string]$Action = "auto", $Value = $null, [bool]$FallbackClick = $true)

    $invokeP = [System.Windows.Automation.InvokePattern]::Pattern
    $toggleP = [System.Windows.Automation.TogglePattern]::Pattern
    $selectP = [System.Windows.Automation.SelectionItemPattern]::Pattern
    $expandP = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
    $valueP = [System.Windows.Automation.ValuePattern]::Pattern

    function Get-Pat($el, $pat) { $p = $null; if ($el.TryGetCurrentPattern($pat, [ref]$p)) { return $p }; return $null }

    if ($Action -eq "setvalue" -or ($Action -eq "auto" -and $null -ne $Value)) {
        $p = Get-Pat $Element $valueP
        if (-not $p) { throw "Element does not support ValuePattern (setvalue)." }
        $p.SetValue([string]$Value)
        return "setvalue"
    }

    switch ($Action) {
        "invoke" { $p = Get-Pat $Element $invokeP; if (-not $p) { throw "No InvokePattern." }; $p.Invoke(); return "invoke" }
        "toggle" { $p = Get-Pat $Element $toggleP; if (-not $p) { throw "No TogglePattern." }; $p.Toggle(); return "toggle" }
        "select" { $p = Get-Pat $Element $selectP; if (-not $p) { throw "No SelectionItemPattern." }; $p.Select(); return "select" }
        "expand" { $p = Get-Pat $Element $expandP; if (-not $p) { throw "No ExpandCollapsePattern." }; $p.Expand(); return "expand" }
        "collapse" { $p = Get-Pat $Element $expandP; if (-not $p) { throw "No ExpandCollapsePattern." }; $p.Collapse(); return "collapse" }
        default {
            $p = Get-Pat $Element $invokeP; if ($p) { $p.Invoke(); return "invoke" }
            $p = Get-Pat $Element $toggleP; if ($p) { $p.Toggle(); return "toggle" }
            $p = Get-Pat $Element $selectP; if ($p) { $p.Select(); return "select" }
            $p = Get-Pat $Element $expandP; if ($p) { $p.Expand(); return "expand" }
            if ($FallbackClick) {
                $rect = $Element.Current.BoundingRectangle
                if (-not [double]::IsInfinity($rect.X) -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
                    Invoke-MouseClick -X ([int]($rect.X + $rect.Width / 2)) -Y ([int]($rect.Y + $rect.Height / 2)) -Button "left"
                    return "click"
                }
            }
            throw "Element exposes no actionable pattern and no fallback click was possible."
        }
    }
}

# OCR fallback for apps that expose no UI Automation tree (CEF/Chromium, custom-drawn UIs,
# games). Tries the built-in Windows.Media.Ocr engine first; if no OCR language is installed
# (e.g. a vanilla Windows Sandbox), falls back to a bundled Tesseract at tools\tesseract.
# Word rects are returned in REAL screen coordinates (capture offset applied).
function Invoke-Ocr {
    param($Region = $null, [string]$Language = "")

    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($Region) { $ox = [int]$Region[0]; $oy = [int]$Region[1]; $w = [int]$Region[2]; $h = [int]$Region[3] }
    else { $ox = $vs.Left; $oy = $vs.Top; $w = $vs.Width; $h = $vs.Height }

    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($ox, $oy, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
    $tmp = Join-Path $env:TEMP ("ocr-" + [guid]::NewGuid().ToString() + ".png")
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    try {
        $result = Invoke-OcrWindows -PngPath $tmp -Language $Language -OffsetX $ox -OffsetY $oy -Width $w -Height $h
        if (-not $result) {
            $tessExe = Join-Path $BridgeRoot "tools\tesseract\tesseract.exe"
            if (Test-Path $tessExe) {
                $result = Invoke-OcrTesseract -PngPath $tmp -TessExe $tessExe -OffsetX $ox -OffsetY $oy -Width $w -Height $h
            }
        }
        if (-not $result) {
            $avail = @()
            try {
                [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
                $avail = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
            }
            catch { }
            throw ("No OCR available: Windows OCR has no recognizer language (available=[" + ($avail -join ",") + "]) and no bundled Tesseract at tools\tesseract\tesseract.exe.")
        }
        return $result
    }
    finally { try { [System.IO.File]::Delete($tmp) } catch { } }
}

function Invoke-OcrWindows {
    param([string]$PngPath, [string]$Language, [int]$OffsetX, [int]$OffsetY, [int]$Width, [int]$Height)

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:OcrAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
            Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    if (-not $script:OcrAsTask) { return $null }
    function AwaitOp($op, $rt) { $t = $script:OcrAsTask.MakeGenericMethod($rt).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }

    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

    $engine = $null
    if ($Language) { try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $Language)) } catch { } }
    if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if (-not $engine) { try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language "en-US")) } catch { } }
    if (-not $engine) { return $null }

    $sf = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PngPath)) ([Windows.Storage.StorageFile])
    $stream = AwaitOp ($sf.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $softwareBitmap = AwaitOp ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = AwaitOp ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])

    $lines = New-Object System.Collections.ArrayList
    foreach ($line in $res.Lines) {
        $words = New-Object System.Collections.ArrayList
        foreach ($wd in $line.Words) {
            $r = $wd.BoundingRect
            $rx = [int]($OffsetX + $r.X); $ry = [int]($OffsetY + $r.Y); $rw = [int]$r.Width; $rh = [int]$r.Height
            [void]$words.Add([ordered]@{ text = $wd.Text; rect = @($rx, $ry, $rw, $rh); click = @([int]($rx + $rw / 2), [int]($ry + $rh / 2)) })
        }
        [void]$lines.Add([ordered]@{ text = $line.Text; words = @($words) })
    }
    return [ordered]@{ engine = ("windows:" + $engine.RecognizerLanguage.LanguageTag); text = $res.Text; lineCount = $lines.Count; lines = @($lines); region = @($OffsetX, $OffsetY, $Width, $Height) }
}

# Bundled Tesseract fallback. Parses TSV output (level=5 rows are words) into lines, mapping
# each word's box from image pixels to real screen coords via the capture offset.
function Invoke-OcrTesseract {
    param([string]$PngPath, [string]$TessExe, [int]$OffsetX, [int]$OffsetY, [int]$Width, [int]$Height)

    $tessDir = Split-Path -Parent $TessExe
    $env:TESSDATA_PREFIX = (Join-Path $tessDir "tessdata")
    # Run via Start-Process with redirected output files so Tesseract's stderr (e.g. the
    # benign "Empty page!!" note) is never turned into a terminating PowerShell error.
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        Start-Process -FilePath $TessExe -ArgumentList @($PngPath, "stdout", "-l", "eng", "--psm", "3", "tsv") `
            -NoNewWindow -Wait -RedirectStandardOutput $outFile -RedirectStandardError $errFile | Out-Null
        $tsv = Get-Content -Path $outFile -ErrorAction SilentlyContinue
    }
    finally {
        foreach ($f in @($outFile, $errFile)) { try { [System.IO.File]::Delete($f) } catch { } }
    }

    $lines = New-Object System.Collections.ArrayList
    $curKey = $null
    $curWords = $null
    foreach ($row in $tsv) {
        $c = $row -split "`t"
        if ($c.Count -lt 12 -or $c[0] -eq 'level' -or $c[0] -ne '5') { continue }
        $text = $c[11]
        if (-not $text -or $text.Trim().Length -eq 0) { continue }
        $rx = $OffsetX + [int]$c[6]; $ry = $OffsetY + [int]$c[7]; $rw = [int]$c[8]; $rh = [int]$c[9]
        $word = [ordered]@{ text = $text; rect = @($rx, $ry, $rw, $rh); click = @([int]($rx + $rw / 2), [int]($ry + $rh / 2)) }
        $key = "$($c[2])_$($c[3])_$($c[4])"
        if ($key -ne $curKey) {
            if ($curWords) { [void]$lines.Add([ordered]@{ text = (($curWords | ForEach-Object { $_.text }) -join " "); words = @($curWords) }) }
            $curWords = New-Object System.Collections.ArrayList
            $curKey = $key
        }
        [void]$curWords.Add($word)
    }
    if ($curWords) { [void]$lines.Add([ordered]@{ text = (($curWords | ForEach-Object { $_.text }) -join " "); words = @($curWords) }) }
    $allText = (($lines | ForEach-Object { $_.text }) -join "`n")
    return [ordered]@{ engine = "tesseract"; text = $allText; lineCount = $lines.Count; lines = @($lines); region = @($OffsetX, $OffsetY, $Width, $Height) }
}

function Test-ElementSupportsAction {
    param($Element, [string]$Action)
    function Has($el, $pat) { $p = $null; return $el.TryGetCurrentPattern($pat, [ref]$p) }
    switch ($Action) {
        "invoke" { return (Has $Element ([System.Windows.Automation.InvokePattern]::Pattern)) }
        "toggle" { return (Has $Element ([System.Windows.Automation.TogglePattern]::Pattern)) }
        "select" { return (Has $Element ([System.Windows.Automation.SelectionItemPattern]::Pattern)) }
        "expand" { return (Has $Element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) }
        "collapse" { return (Has $Element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) }
        "setvalue" { return (Has $Element ([System.Windows.Automation.ValuePattern]::Pattern)) }
        default {
            return ((Has $Element ([System.Windows.Automation.InvokePattern]::Pattern)) -or
                (Has $Element ([System.Windows.Automation.TogglePattern]::Pattern)) -or
                (Has $Element ([System.Windows.Automation.SelectionItemPattern]::Pattern)) -or
                (Has $Element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)))
        }
    }
}

function Invoke-AgentCommand {
    param([pscustomobject]$Command)

    $type = [string]$Command.type
    $args = $Command.args

    switch ($type) {
        "screenshot" {
            $maxWidth = [int](Get-ArgValue $args "maxWidth" 1280)
            $quality = [int](Get-ArgValue $args "quality" 70)
            $region = Get-ArgValue $args "region" $null
            $window = [bool](Get-ArgValue $args "window" $false)
            $shot = New-Screenshot -Id $Command.id -MaxWidth $maxWidth -Quality $quality -Region $region -Window $window
            return @{
                data = $shot
                artifacts = @($shot.path)
            }
        }
        "ui_tree" {
            $scope = [string](Get-ArgValue $args "scope" "window")
            $maxDepth = [int](Get-ArgValue $args "maxDepth" 12)
            $maxNodes = [int](Get-ArgValue $args "maxNodes" 400)
            $onlyInteractive = [bool](Get-ArgValue $args "onlyInteractive" $false)
            return @{ data = (Get-UiTree -Scope $scope -MaxDepth $maxDepth -MaxNodes $maxNodes -OnlyInteractive $onlyInteractive) }
        }
        "ocr" {
            $region = Get-ArgValue $args "region" $null
            $language = [string](Get-ArgValue $args "language" "")
            return @{ data = (Invoke-Ocr -Region $region -Language $language) }
        }
        "inventory" {
            return @{ data = @(Get-InstalledPrograms) }
        }
        "installer_candidates" {
            $path = [string](Get-ArgValue $args "path" "")
            $recurse = [bool](Get-ArgValue $args "recurse" $true)
            return @{ data = @(Get-InstallerCandidates -Path $path -Recurse $recurse) }
        }
        "msi_inspect" {
            $path = [string](Get-ArgValue $args "path" "")
            if (-not $path) { throw "msi_inspect requires 'path'." }
            return @{ data = (Get-MsiInfo -Path $path) }
        }
        "installer_analyze" {
            $path = [string](Get-ArgValue $args "path" "")
            $recurse = [bool](Get-ArgValue $args "recurse" $true)
            return @{ data = (Get-InstallerFolderAnalysis -Path $path -Recurse $recurse) }
        }
        "installer_test" {
            $command = [string](Get-ArgValue $args "command" "")
            $timeoutMs = [int](Get-ArgValue $args "timeoutMs" 120000)
            $logPath = [string](Get-ArgValue $args "logPath" "")
            $logTailLines = [int](Get-ArgValue $args "logTailLines" 80)
            $workingDirectory = [string](Get-ArgValue $args "workingDirectory" "")
            return @{ data = (Invoke-InstallerCommandTest -Command $command -TimeoutMs $timeoutMs -LogPath $logPath -LogTailLines $logTailLines -WorkingDirectory $workingDirectory) }
        }
        "detection_verify" {
            $rule = Get-ArgValue $args "rule" $null
            $expectedPresent = [bool](Get-ArgValue $args "expectedPresent" $true)
            $timeoutMs = [int](Get-ArgValue $args "timeoutMs" 30000)
            return @{ data = (Test-DetectionRule -Rule $rule -ExpectedPresent $expectedPresent -TimeoutMs $timeoutMs) }
        }
        "assert" {
            $assertions = Get-ArgValue $args "assertions" $null
            $timeoutMs = [int](Get-ArgValue $args "timeoutMs" 30000)
            return @{ data = (Invoke-AssertionSet -Assertions $assertions -TimeoutMs $timeoutMs) }
        }
        "job_start_ps" {
            $command = [string](Get-ArgValue $args "command" "")
            $timeoutMs = [int](Get-ArgValue $args "timeoutMs" 600000)
            $workingDirectory = [string](Get-ArgValue $args "workingDirectory" "")
            return @{ data = (Start-SandboxPowerShellJob -Command $command -TimeoutMs $timeoutMs -WorkingDirectory $workingDirectory) }
        }
        "job_status" {
            $jobId = [string](Get-ArgValue $args "jobId" "")
            $tailLines = [int](Get-ArgValue $args "tailLines" 80)
            return @{ data = (Get-SandboxJobStatus -JobId $jobId -TailLines $tailLines) }
        }
        "job_cancel" {
            $jobId = [string](Get-ArgValue $args "jobId" "")
            return @{ data = (Stop-SandboxJob -JobId $jobId) }
        }
        "intune_prereqs" {
            $toolPath = [string](Get-ArgValue $args "toolPath" "")
            $ensureTool = [bool](Get-ArgValue $args "ensureTool" $true)
            $downloadUrl = [string](Get-ArgValue $args "downloadUrl" "")
            return @{ data = (Resolve-IntuneWinAppUtil -ToolPath $toolPath -EnsureTool $ensureTool -DownloadUrl $downloadUrl) }
        }
        "intune_package" {
            $sourceFolder = [string](Get-ArgValue $args "sourceFolder" "")
            $setupFile = [string](Get-ArgValue $args "setupFile" "")
            $outputFolder = [string](Get-ArgValue $args "outputFolder" "")
            $installCommand = [string](Get-ArgValue $args "installCommand" "")
            $uninstallCommand = [string](Get-ArgValue $args "uninstallCommand" "")
            $detectionRule = Get-ArgValue $args "detectionRule" $null
            $toolPath = [string](Get-ArgValue $args "toolPath" "")
            $ensureTool = [bool](Get-ArgValue $args "ensureTool" $true)
            $downloadUrl = [string](Get-ArgValue $args "downloadUrl" "")
            $quiet = [bool](Get-ArgValue $args "quiet" $true)
            $includeCatalog = [bool](Get-ArgValue $args "includeCatalog" $false)
            $timeoutMs = [int](Get-ArgValue $args "timeoutMs" 300000)
            $testInstall = [bool](Get-ArgValue $args "testInstall" $true)
            $installTestTimeoutMs = [int](Get-ArgValue $args "installTestTimeoutMs" 90000)
            $verifyDetection = [bool](Get-ArgValue $args "verifyDetection" $true)
            $testUninstall = [bool](Get-ArgValue $args "testUninstall" $true)
            $uninstallTestTimeoutMs = [int](Get-ArgValue $args "uninstallTestTimeoutMs" 90000)
            return @{ data = (Invoke-IntuneWin32Package -SourceFolder $sourceFolder -SetupFile $setupFile -OutputFolder $outputFolder -InstallCommand $installCommand -UninstallCommand $uninstallCommand -DetectionRule $detectionRule -ToolPath $toolPath -EnsureTool $ensureTool -DownloadUrl $downloadUrl -Quiet $quiet -IncludeCatalog $includeCatalog -TimeoutMs $timeoutMs -TestInstall $testInstall -InstallTestTimeoutMs $installTestTimeoutMs -VerifyDetection $verifyDetection -TestUninstall $testUninstall -UninstallTestTimeoutMs $uninstallTestTimeoutMs) }
        }
        "processes" {
            $processes = Get-Process |
                Sort-Object ProcessName |
                Select-Object ProcessName, Id, MainWindowTitle, Path
            return @{ data = @($processes) }
        }
        "screen_info" {
            $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
            $screens = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
                [pscustomobject]@{
                    deviceName = $_.DeviceName
                    primary = $_.Primary
                    width = $_.Bounds.Width
                    height = $_.Bounds.Height
                    left = $_.Bounds.Left
                    top = $_.Bounds.Top
                    workingWidth = $_.WorkingArea.Width
                    workingHeight = $_.WorkingArea.Height
                }
            }
            return @{
                data = @{
                    virtualScreen = @{
                        width = $virtual.Width
                        height = $virtual.Height
                        left = $virtual.Left
                        top = $virtual.Top
                    }
                    screens = @($screens)
                }
            }
        }
        "click" {
            Invoke-MouseClick -X ([int]$args.x) -Y ([int]$args.y) -Button ([string]$args.button)
            return @{ data = @{ clicked = $true; x = [int]$args.x; y = [int]$args.y; button = [string]$args.button } }
        }
        "double_click" {
            $x = [int](Get-ArgValue $args "x" 0); $y = [int](Get-ArgValue $args "y" 0)
            Invoke-MouseClick -X $x -Y $y -Button "left"
            Start-Sleep -Milliseconds 80
            [SandboxInput]::mouse_event([SandboxInput]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            [SandboxInput]::mouse_event([SandboxInput]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
            return @{ data = @{ doubleClicked = $true; x = $x; y = $y } }
        }
        "scroll" {
            $x = [int](Get-ArgValue $args "x" 0); $y = [int](Get-ArgValue $args "y" 0)
            $ticks = [int](Get-ArgValue $args "ticks" -3)   # positive = up, negative = down
            [SandboxInput]::SetCursorPos($x, $y) | Out-Null
            Start-Sleep -Milliseconds 50
            # MOUSEEVENTF_WHEEL = 0x0800; dwData carries the signed wheel delta as a uint
            # (two's complement for scroll-down). Mask with an Int64 literal so a negative
            # delta becomes the correct 32-bit unsigned bit pattern.
            $delta = $ticks * 120
            $dw = [uint32]([int64]$delta -band 0xFFFFFFFFL)
            [SandboxInput]::mouse_event(0x0800, 0, 0, $dw, [UIntPtr]::Zero)
            return @{ data = @{ scrolled = $true; x = $x; y = $y; ticks = $ticks } }
        }
        "drag" {
            $fx = [int](Get-ArgValue $args "fromX" 0); $fy = [int](Get-ArgValue $args "fromY" 0)
            $tx = [int](Get-ArgValue $args "toX" 0); $ty = [int](Get-ArgValue $args "toY" 0)
            [SandboxInput]::SetCursorPos($fx, $fy) | Out-Null
            Start-Sleep -Milliseconds 60
            [SandboxInput]::mouse_event([SandboxInput]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            $steps = 20
            for ($i = 1; $i -le $steps; $i++) {
                $ix = [int]($fx + ($tx - $fx) * $i / $steps)
                $iy = [int]($fy + ($ty - $fy) * $i / $steps)
                [SandboxInput]::SetCursorPos($ix, $iy) | Out-Null
                Start-Sleep -Milliseconds 12
            }
            [SandboxInput]::mouse_event([SandboxInput]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
            return @{ data = @{ dragged = $true; from = @($fx, $fy); to = @($tx, $ty) } }
        }
        "type" {
            [System.Windows.Forms.SendKeys]::SendWait([string]$args.text)
            return @{ data = @{ typed = $true; length = ([string]$args.text).Length } }
        }
        "paste" {
            [System.Windows.Forms.Clipboard]::SetText([string]$args.text)
            Start-Sleep -Milliseconds 100
            [System.Windows.Forms.SendKeys]::SendWait("^v")
            return @{ data = @{ pasted = $true; length = ([string]$args.text).Length } }
        }
        "set_focused_text" {
            $element = [System.Windows.Automation.AutomationElement]::FocusedElement
            if (-not $element) {
                throw "No focused UI Automation element found."
            }

            $pattern = $null
            if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                throw "Focused element does not support ValuePattern."
            }

            $pattern.SetValue([string]$args.text)
            return @{
                data = @{
                    set = $true
                    length = ([string]$args.text).Length
                    name = $element.Current.Name
                    automationId = $element.Current.AutomationId
                    controlType = $element.Current.ControlType.ProgrammaticName
                }
            }
        }
        "invoke" {
            $scope = [string](Get-ArgValue $args "scope" "window")
            $name = [string](Get-ArgValue $args "name" "")
            $autoId = [string](Get-ArgValue $args "automationId" "")
            $ctype = [string](Get-ArgValue $args "controlType" "")
            $matchMode = [string](Get-ArgValue $args "match" "contains")
            $index = [int](Get-ArgValue $args "index" 0)
            $action = [string](Get-ArgValue $args "action" "auto")
            $value = Get-ArgValue $args "value" $null
            $fallbackClick = [bool](Get-ArgValue $args "fallbackClick" $true)

            if (-not $name -and -not $autoId) { throw "invoke requires 'name' and/or 'automationId'." }
            $root = Resolve-UiRoot -Scope $scope
            if (-not $root) { throw "Could not resolve a UI Automation root element." }
            $found = @(Find-UiElements -Root $root -Name $name -AutomationId $autoId -ControlType $ctype -Match $matchMode)
            if ($found.Count -eq 0) { throw "No element matched (name='$name' automationId='$autoId' controlType='$ctype')." }
            if ($index -ge $found.Count) { throw "index $index out of range ($($found.Count) matches)." }

            # With several matches (e.g. a Text label sharing a Button's name), prefer the one
            # that actually supports the requested action, unless an explicit index was given.
            $el = $null
            if ($index -gt 0) {
                $el = $found[$index]
            }
            else {
                foreach ($cand in $found) {
                    if (Test-ElementSupportsAction -Element $cand -Action $action) { $el = $cand; break }
                }
                if (-not $el) { $el = $found[0] }
            }
            $info = $el.Current
            $performed = Invoke-UiElement -Element $el -Action $action -Value $value -FallbackClick $fallbackClick
            return @{ data = @{
                    invoked = $true
                    action = $performed
                    matchCount = $found.Count
                    name = [string]$info.Name
                    automationId = [string]$info.AutomationId
                    controlType = ($info.ControlType.ProgrammaticName -replace '^ControlType\.', '')
                } }
        }
        "wait_for" {
            $scope = [string](Get-ArgValue $args "scope" "window")
            $name = [string](Get-ArgValue $args "name" "")
            $autoId = [string](Get-ArgValue $args "automationId" "")
            $ctype = [string](Get-ArgValue $args "controlType" "")
            $matchMode = [string](Get-ArgValue $args "match" "contains")
            $timeoutMs = [int](Get-ArgValue $args "timeoutMs" 10000)
            $pollMs = [int](Get-ArgValue $args "pollMs" 200)
            $absent = [bool](Get-ArgValue $args "absent" $false)

            if (-not $name -and -not $autoId) { throw "wait_for requires 'name' and/or 'automationId'." }
            $start = Get-Date
            $deadline = $start.AddMilliseconds($timeoutMs)
            $element = $null
            $present = $false
            while ($true) {
                $root = Resolve-UiRoot -Scope $scope
                $found = @()
                if ($root) { $found = @(Find-UiElements -Root $root -Name $name -AutomationId $autoId -ControlType $ctype -Match $matchMode) }
                $present = $found.Count -gt 0
                if ($absent) {
                    if (-not $present) { break }
                }
                elseif ($present) {
                    $element = $found[0]
                    break
                }
                if ((Get-Date) -ge $deadline) { break }
                Start-Sleep -Milliseconds $pollMs
            }

            $elapsed = [int]((Get-Date) - $start).TotalMilliseconds
            $satisfied = if ($absent) { -not $present } else { $present }
            $result = @{ found = $present; satisfied = $satisfied; timedOut = (-not $satisfied); waitedMs = $elapsed }
            if ($element) {
                $ei = $element.Current
                $r = $ei.BoundingRectangle
                $result.name = [string]$ei.Name
                $result.automationId = [string]$ei.AutomationId
                $result.controlType = ($ei.ControlType.ProgrammaticName -replace '^ControlType\.', '')
                if (-not [double]::IsInfinity($r.X) -and $r.Width -gt 0 -and $r.Height -gt 0) {
                    $result.rect = @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
                    $result.click = @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
                }
            }
            return @{ data = $result }
        }
        "key" {
            [System.Windows.Forms.SendKeys]::SendWait([string]$args.keys)
            return @{ data = @{ sent = [string]$args.keys } }
        }
        "open" {
            $target = [string]$args.target
            Start-Process -FilePath $target

            # After launching, poll top-level windows for a shell error / app-picker dialog
            # ("We can't open this ... link", "How do you want to open this file?", "No apps are
            # installed", ...) so the caller learns immediately when the target did NOT open the
            # expected app (e.g. a UWP app that isn't present in the Sandbox). These dialogs can
            # take a second or two to appear, so poll rather than checking once.
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $pattern = "can.t open|How do you want to open|Pick an app|No apps( are)? installed|does not have an app associated"
            $warning = $null
            $windows = @()
            $deadline = (Get-Date).AddSeconds(3.5)
            while ((Get-Date) -lt $deadline -and -not $warning) {
                Start-Sleep -Milliseconds 400
                $found = New-Object System.Collections.ArrayList
                try {
                    $w = $walker.GetFirstChild([System.Windows.Automation.AutomationElement]::RootElement)
                    $seenWin = 0
                    while ($w -and $seenWin -lt 40 -and -not $warning) {
                        $seenWin++
                        $wn = ""
                        try { $wn = [string]$w.Current.Name } catch { }
                        if ($wn) { [void]$found.Add($wn) }
                        # Only inspect real dialog/app Windows — not the desktop/taskbar Panes
                        # (whose running-app buttons would otherwise false-match).
                        $ct = ""
                        try { $ct = [string]$w.Current.ControlType.ProgrammaticName } catch { }
                        if ($ct -eq "ControlType.Window") {
                            # depth-limited text scan of this window to catch the dialog message
                            $text = $wn
                            $stack = New-Object System.Collections.Stack
                            $stack.Push([pscustomobject]@{ el = $w; depth = 0 })
                            $nodes = 0
                            while ($stack.Count -gt 0 -and $nodes -lt 50) {
                                $fr = $stack.Pop(); $nodes++
                                try { $en = [string]$fr.el.Current.Name; if ($en) { $text += " | " + $en } } catch { }
                                if ($fr.depth -lt 3) {
                                    try {
                                        $ch = $walker.GetFirstChild($fr.el)
                                        while ($ch) { $stack.Push([pscustomobject]@{ el = $ch; depth = ($fr.depth + 1) }); $ch = $walker.GetNextSibling($ch) }
                                    }
                                    catch { }
                                }
                            }
                            if ($text -match $pattern) {
                                $warning = (($text -replace '\s+', ' ').Trim())
                                if ($warning.Length -gt 220) { $warning = $warning.Substring(0, 220) }
                            }
                        }
                        $w = $walker.GetNextSibling($w)
                    }
                }
                catch { }
                $windows = @($found)
            }
            return @{ data = @{ opened = $target; windows = @($windows); warning = $warning } }
        }
        "run_ps" {
            $command = [string](Get-ArgValue $args "command" "")
            $timeoutMs = [int](Get-ArgValue $args "timeoutMs" 60000)
            $wrappedCommand = '$ProgressPreference = "SilentlyContinue"; ' + $command
            $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($wrappedCommand))
            $result = Invoke-CapturedProcess -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded) -TimeoutMs $timeoutMs
            return @{ data = @{ output = (($result.stdout + $result.stderr) | Out-String); shell = "powershell"; exitCode = $result.exitCode; timedOut = $result.timedOut; timeoutMs = $result.timeoutMs; stdout = $result.stdout; stderr = $result.stderr } }
        }
        "run_cmd" {
            $output = & cmd.exe /c ([string]$args.command) 2>&1 | Out-String
            return @{ data = @{ output = $output; shell = "cmd" } }
        }
        "wait" {
            Start-Sleep -Milliseconds ([int]$args.milliseconds)
            return @{ data = @{ waitedMilliseconds = [int]$args.milliseconds } }
        }
        "center_window" {
            return @{ data = Center-ForegroundWindow }
        }
        "health" {
            $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
            $fg = ""
            try {
                $h = [SandboxInput]::GetForegroundWindow()
                if ($h -ne [IntPtr]::Zero) {
                    $fgEl = [System.Windows.Automation.AutomationElement]::FromHandle($h)
                    if ($fgEl) { $fg = [string]$fgEl.Current.Name }
                }
            }
            catch { }
            return @{ data = @{
                    ok = $true
                    transport = "socket"
                    pid = $PID
                    screen = @($vs.Width, $vs.Height)
                    headless = ($vs.Width -le 320 -and $vs.Height -le 320)
                    foreground = $fg
                } }
        }
        "stop_agent" {
            return @{ data = @{ stopping = $true } }
        }
        default {
            throw "Unknown command type: $type"
        }
    }
}

function Write-Result {
    param(
        [string]$Id,
        [object]$Result
    )

    $tmp = Join-Path $ResultsDir "$Id.tmp"
    $final = Join-Path $ResultsDir "$Id.json"
    $json = $Result | ConvertTo-Json -Depth 20
    # Write UTF-8 without a BOM so non-PowerShell consumers (e.g. the Node MCP server)
    # can JSON.parse it directly. Set-Content -Encoding UTF8 on PS 5.1 prepends a BOM.
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -Force -Path $tmp -Destination $final
}

function Start-SocketAgent {
    param([int]$Port)

    # Open the guest firewall for inbound connections on the agent port. The guest is a
    # disposable Sandbox running as admin, so this is safe and self-contained. netsh is used
    # instead of New-NetFirewallRule because the cmdlet loads a heavy module (~seconds).
    try {
        & netsh advfirewall firewall add rule name="SandboxAgentSocket" dir=in action=allow protocol=TCP localport=$Port | Out-Null
    }
    catch { Write-AgentLog "Firewall rule add failed: $($_.Exception.Message)" }

    # Publish our endpoint (IP + port) on the share so the host can connect out to us.
    # Robust discovery: prefer the adapter with the default gateway, else any non-loopback
    # non-APIPA IPv4 (preferring the 172.* Sandbox NAT range), retrying briefly if the
    # network stack is still settling after a fresh agent start.
    $ip = $null
    for ($try = 0; $try -lt 10 -and -not $ip; $try++) {
        try {
            $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1
            if ($cfg -and $cfg.IPv4Address) { $ip = @($cfg.IPv4Address.IPAddress)[0] }
        }
        catch { }
        if (-not $ip) {
            try {
                $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
                        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
                        Sort-Object @{ Expression = { if ($_.IPAddress -like '172.*') { 0 } else { 1 } } } |
                        Select-Object -First 1).IPAddress
            }
            catch { }
        }
        if (-not $ip) { Start-Sleep -Milliseconds 500 }
    }
    $ip = [string]$ip
    # Per-session auth token: the host must present it as the first line of a connection.
    $token = [guid]::NewGuid().ToString("N")
    $endpoint = [ordered]@{ ip = $ip; port = $Port; token = $token; pid = $PID; publishedAt = (Get-Date).ToString("o") }
    $endpointPath = Join-Path $ResultsDir "agent-endpoint.json"
    [System.IO.File]::WriteAllText($endpointPath, ($endpoint | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    Write-AgentLog "Socket agent endpoint ip=$ip port=$Port"

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
    $listener.Start()
    $running = $true

    while ($running) {
        $client = $listener.AcceptTcpClient()
        $client.NoDelay = $true
        Write-AgentLog "Socket client connected from $($client.Client.RemoteEndPoint)"
        $stream = $client.GetStream()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
        $writer.AutoFlush = $true

        try {
            # The first line of a connection must be the auth token from agent-endpoint.json.
            $handshake = $reader.ReadLine()
            if ($handshake -ne $token) {
                Write-AgentLog "Rejected connection from $($client.Client.RemoteEndPoint): bad/missing auth token."
            }
            else {
            while ($running) {
                $line = $reader.ReadLine()
                if ($null -eq $line) { break }   # client disconnected
                if ($line.Trim().Length -eq 0) { continue }

                $command = $null
                $started = Get-Date
                try {
                    $command = $line | ConvertFrom-Json
                    if (-not $command.id) { throw "Command is missing an id." }
                    Write-AgentLog "Socket command $($command.id): $($command.type)"
                    $payload = Invoke-AgentCommand -Command $command

                    # For screenshots, embed the JPEG as base64 so the host needs no
                    # shared-folder read (the slow direction).
                    if ($command.type -eq "screenshot" -and $payload.data -and $payload.data.path -and (Test-Path $payload.data.path)) {
                        $bytes = [System.IO.File]::ReadAllBytes($payload.data.path)
                        $payload.data | Add-Member -NotePropertyName imageBase64 -NotePropertyValue ([Convert]::ToBase64String($bytes)) -Force
                    }

                    $result = [ordered]@{
                        id = $command.id; type = $command.type; ok = $true
                        startedAt = $started.ToString("o"); finishedAt = (Get-Date).ToString("o")
                        data = $payload.data; error = $null
                    }
                    if ($command.type -eq "stop_agent") { $running = $false }
                }
                catch {
                    $result = [ordered]@{
                        id = $(if ($command -and $command.id) { $command.id } else { $null })
                        type = $null; ok = $false
                        startedAt = $started.ToString("o"); finishedAt = (Get-Date).ToString("o")
                        data = $null; error = $_.Exception.Message
                    }
                    Write-AgentLog "Socket command failed: $($_.Exception.Message)"
                }

                $writer.WriteLine(($result | ConvertTo-Json -Depth 20 -Compress))
            }
            }
        }
        catch {
            Write-AgentLog "Socket session error: $($_.Exception.Message)"
        }
        finally {
            $reader.Dispose(); $writer.Dispose(); $client.Close()
        }
    }

    $listener.Stop()
    Write-AgentLog "Socket agent stopped"
}

Write-AgentLog "Sandbox agent started from $BridgeRoot"

if ($SocketPort -gt 0) {
    Start-SocketAgent -Port $SocketPort
    return
}

$running = $true

while ($running) {
    $files = Get-ChildItem -Path $CommandsDir -Filter "*.json" -File -ErrorAction SilentlyContinue |
        Sort-Object CreationTimeUtc

    foreach ($file in $files) {
        $started = Get-Date
        try {
            $raw = Get-Content -Path $file.FullName -Raw
            $command = $raw | ConvertFrom-Json
            if (-not $command.id) {
                throw "Command file $($file.Name) is missing an id."
            }

            Write-AgentLog "Running command $($command.id): $($command.type)"
            $payload = Invoke-AgentCommand -Command $command
            $finished = Get-Date
            $artifacts = @()
            if ($payload.ContainsKey("artifacts") -and $payload.artifacts) {
                $artifacts = @($payload.artifacts)
            }

            $result = [ordered]@{
                id = $command.id
                type = $command.type
                ok = $true
                startedAt = $started.ToString("o")
                finishedAt = $finished.ToString("o")
                data = $payload.data
                artifacts = $artifacts
                error = $null
            }

            if ($command.type -eq "stop_agent") {
                $running = $false
            }
        }
        catch {
            $finished = Get-Date
            $id = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
            $result = [ordered]@{
                id = $id
                type = $null
                ok = $false
                startedAt = $started.ToString("o")
                finishedAt = $finished.ToString("o")
                data = $null
                artifacts = @()
                error = $_.Exception.Message
            }
            Write-AgentLog "Command failed: $($_.Exception.Message)"
        }

        Write-Result -Id $result.id -Result $result
        Move-Item -Force -Path $file.FullName -Destination (Join-Path $ProcessedDir $file.Name)
    }

    if ($running) {
        # Short poll for low latency. (FileSystemWatcher.WaitForChanged proved unreliable
        # here — its timeout did not fire promptly, stalling command pickup by ~30s.)
        Start-Sleep -Milliseconds 100
    }
}

Write-AgentLog "Sandbox agent stopped"
