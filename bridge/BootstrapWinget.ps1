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

"Repairing / bootstrapping Windows Package Manager..."
Repair-WinGetPackageManager -AllUsers

"winget version:"
winget --version
