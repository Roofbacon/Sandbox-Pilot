$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

"Installing NuGet package provider..."
Install-PackageProvider -Name NuGet -Force | Out-Null

"Trusting PSGallery for this disposable Sandbox session..."
Set-PSRepository -Name PSGallery -InstallationPolicy Trusted

"Installing Microsoft.WinGet.Client..."
Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery -Scope CurrentUser | Out-Null
Import-Module Microsoft.WinGet.Client

"Repairing / bootstrapping Windows Package Manager (this pulls the latest App Installer)..."
try {
    Repair-WinGetPackageManager -Latest -AllUsers -ErrorAction Stop
}
catch {
    "  -AllUsers repair failed ($($_.Exception.Message)); retrying for the current user..."
    Repair-WinGetPackageManager -Latest
}

# The first winget invocation can race the freshly-registered App Installer package; give it a
# few attempts before declaring failure.
$version = $null
for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
        $version = (winget --version) 2>$null
        if ($LASTEXITCODE -eq 0 -and $version) { break }
    }
    catch { }
    Start-Sleep -Seconds 2
}

if ($version) {
    "winget version: $version"
}
else {
    throw "winget did not become available after the repair flow."
}
