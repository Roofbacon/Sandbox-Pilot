param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [string]$MetadataPath,
    [ValidateSet("screen", "image")][string]$Mode = "image",
    [string]$ShapesJson,
    [string]$ShapesPath,
    [int]$Quality = 85
)

# Draws boxes / arrows / labels / spotlight onto a screenshot.
# Coordinate modes:
#   image  - coords are in the screenshot's own pixels (read straight off the JPEG)
#   screen - coords are in real screen pixels (same space as ui_tree rects + click
#            commands); mapped onto the image using the capture metadata's "scale".
# This step is app-agnostic: it never touches UI Automation, so it works for
# ui_tree-capable apps (feed element rects) AND non-ui_tree apps like CEF dialogs,
# custom-drawn UIs, or games (feed the coords you already used to click).

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$scale = 1.0
$offX = 0.0
$offY = 0.0
if ($Mode -eq "screen") {
    if (-not $MetadataPath -or -not (Test-Path $MetadataPath)) {
        throw "screen mode requires -MetadataPath (the screenshot's *.json with scale/left/top)."
    }
    $meta = Get-Content -Path $MetadataPath -Raw | ConvertFrom-Json
    $scale = [double]$meta.scale
    if ($null -ne $meta.left) { $offX = [double]$meta.left }
    if ($null -ne $meta.top) { $offY = [double]$meta.top }
}

if ($ShapesPath) {
    if (-not (Test-Path $ShapesPath)) { throw "ShapesPath not found: $ShapesPath" }
    $ShapesJson = Get-Content -Path $ShapesPath -Raw
}
if (-not $ShapesJson) { throw "Provide -ShapesJson or -ShapesPath." }
$shapes = $ShapesJson | ConvertFrom-Json

function Resolve-Color {
    param([string]$Name, $Default)
    if (-not $Name) { return $Default }
    try { return [System.Drawing.ColorTranslator]::FromHtml($Name) } catch { }
    try {
        $c = [System.Drawing.Color]::FromName($Name)
        if ($c.A -ne 0) { return $c }
    }
    catch { }
    return $Default
}

# Map coordinates from the chosen space to image pixels. In screen mode, subtract the capture
# origin (left/top) so window/region screenshots annotate correctly; in image mode the offset
# is 0 and scale is 1. PS maps lengths (width/height) — scale only, no offset.
function PX { param([double]$v) return [single](($v - $offX) * $scale) }
function PY { param([double]$v) return [single](($v - $offY) * $scale) }
function PSize { param([double]$v) return [single]($v * $scale) }   # not "PS" — that aliases Get-Process

$src = [System.Drawing.Image]::FromFile((Resolve-Path $InputPath).Path)
$bmp = New-Object System.Drawing.Bitmap $src   # detach from the file lock
$src.Dispose()

$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

foreach ($s in $shapes) {
    $type = [string]$s.type
    $color = Resolve-Color $s.color ([System.Drawing.Color]::Red)
    $thickness = if ($null -ne $s.thickness) { [single]$s.thickness } else { [single]4 }

    switch ($type) {
        "box" {
            $pen = New-Object System.Drawing.Pen($color, $thickness)
            $g.DrawRectangle($pen, (PX $s.rect[0]), (PY $s.rect[1]), (PSize $s.rect[2]), (PSize $s.rect[3]))
            $pen.Dispose()
        }
        "arrow" {
            $pen = New-Object System.Drawing.Pen($color, $thickness)
            $pen.CustomEndCap = New-Object System.Drawing.Drawing2D.AdjustableArrowCap(5, 5)
            $g.DrawLine($pen, (PX $s.from[0]), (PY $s.from[1]), (PX $s.to[0]), (PY $s.to[1]))
            $pen.Dispose()
        }
        "label" {
            $fontSize = if ($null -ne $s.size) { [single]$s.size } else { [single]16 }
            $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold)
            $text = [string]$s.text
            $sz = $g.MeasureString($text, $font)
            $x = PX $s.at[0]
            $y = PY $s.at[1]
            $pad = [single]5
            $bg = Resolve-Color $s.bg $color
            $bgBrush = New-Object System.Drawing.SolidBrush($bg)
            $g.FillRectangle($bgBrush, $x, $y, ($sz.Width + 2 * $pad), ($sz.Height + 2 * $pad))
            $bgBrush.Dispose()
            $fg = Resolve-Color $s.textColor ([System.Drawing.Color]::White)
            $fgBrush = New-Object System.Drawing.SolidBrush($fg)
            $g.DrawString($text, $font, $fgBrush, ($x + $pad), ($y + $pad))
            $fgBrush.Dispose()
            $font.Dispose()
        }
        "spotlight" {
            $alpha = if ($null -ne $s.dim) { [int]$s.dim } else { 120 }
            $overlay = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($alpha, 0, 0, 0))
            $rx = PX $s.rect[0]; $ry = PY $s.rect[1]; $rw = PSize $s.rect[2]; $rh = PSize $s.rect[3]
            $W = $bmp.Width; $H = $bmp.Height
            $g.FillRectangle($overlay, 0, 0, [single]$W, $ry)
            $g.FillRectangle($overlay, 0, ($ry + $rh), [single]$W, [single]($H - ($ry + $rh)))
            $g.FillRectangle($overlay, 0, $ry, $rx, $rh)
            $g.FillRectangle($overlay, ($rx + $rw), $ry, [single]($W - ($rx + $rw)), $rh)
            $overlay.Dispose()
        }
        default { throw "Unknown shape type: $type" }
    }
}

$g.Dispose()

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.FormatID -eq [System.Drawing.Imaging.ImageFormat]::Jpeg.Guid } |
    Select-Object -First 1
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
$bmp.Save((Join-Path (Split-Path -Parent $OutputPath) (Split-Path -Leaf $OutputPath)), $jpegCodec, $ep)
$bmp.Dispose()

[pscustomobject]@{ output = $OutputPath; mode = $Mode; scale = $scale; shapes = $shapes.Count } | ConvertTo-Json -Compress
