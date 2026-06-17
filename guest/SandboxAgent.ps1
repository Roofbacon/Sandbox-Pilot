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
$LogsDir = Join-Path $BridgeRoot "logs"
$LogPath = Join-Path $LogsDir "sandbox-agent.log"

foreach ($dir in @($CommandsDir, $ProcessedDir, $ResultsDir, $ArtifactsDir, $ScreenshotsDir, $LogsDir)) {
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
            Where-Object { $_.DisplayName } |
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
            Start-Process -FilePath ([string]$args.target)
            return @{ data = @{ opened = [string]$args.target } }
        }
        "run_ps" {
            $output = Invoke-Expression ([string]$args.command) *>&1 | Out-String
            return @{ data = @{ output = $output; shell = "powershell" } }
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
