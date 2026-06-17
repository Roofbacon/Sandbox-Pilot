# Runs INSIDE the Sandbox (as System) to bundle Tesseract for offline OCR.
# Expects the installer already downloaded to C:\SandboxBridge\tools\_tess_installer\ by the
# host (bundle-tesseract). Silently installs it, copies the runtime into the mapped
# tools\tesseract folder (so it persists to the host), trims training tools, and writes a marker.
$out = "C:\SandboxBridge\results\tess-bundle.txt"
try {
    $exe = Get-ChildItem "C:\SandboxBridge\tools\_tess_installer\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) { Set-Content -Path $out -Value "ERR: installer not found under tools\_tess_installer" -Encoding ascii; exit }

    $p = Start-Process -FilePath $exe.FullName -ArgumentList "/S" -Wait -PassThru
    Start-Sleep -Seconds 2

    $cands = @(
        "C:\Program Files\Tesseract-OCR\tesseract.exe",
        "C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        "C:\TessInstall\tesseract.exe"
    )
    $src = $null
    foreach ($c in $cands) { if (Test-Path $c) { $src = Split-Path $c -Parent; break } }
    if (-not $src) { Set-Content -Path $out -Value ("ERR: tesseract.exe not found after install (exit " + $p.ExitCode + ")") -Encoding ascii; exit }

    $dst = "C:\SandboxBridge\tools\tesseract"
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item "$src\*" $dst -Recurse -Force

    # Trim: only tesseract.exe + DLLs + tessdata are needed for recognition.
    $drop = @("text2image", "lstmtraining", "lstmeval", "set_unicharset_properties", "mftraining",
        "shapeclustering", "classifier_tester", "cntraining", "unicharset_extractor", "combine_lang_model",
        "wordlist2dawg", "ambiguous_words", "dawg2wordlist", "merge_unicharsets", "combine_tessdata",
        "winpath", "tesseract-uninstall")
    foreach ($d in $drop) { Remove-Item -Force (Join-Path $dst "$d.exe") -ErrorAction SilentlyContinue }
    Get-ChildItem $dst -Filter *.html -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force (Join-Path $dst "doc") -ErrorAction SilentlyContinue
    Get-ChildItem (Join-Path $dst "tessdata") -Filter *.jar -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

    $ver = (& "$dst\tesseract.exe" --version 2>&1 | Select-Object -First 1)
    $mb = [math]::Round(((Get-ChildItem $dst -Recurse | Measure-Object Length -Sum).Sum / 1MB))
    Set-Content -Path $out -Value ("OK " + $ver + " sizeMB=" + $mb) -Encoding ascii
}
catch {
    Set-Content -Path $out -Value ("ERR " + $_.Exception.Message) -Encoding ascii
}
