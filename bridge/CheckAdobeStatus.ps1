$ErrorActionPreference = "Continue"

$processes = Get-Process winget,msiexec,AcroRd32,AcroCEF,Acrobat -ErrorAction SilentlyContinue |
    Select-Object ProcessName, Id, StartTime, Path

$registryPaths = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
)

$programs = foreach ($path in $registryPaths) {
    Get-ItemProperty -Path $path -ErrorAction SilentlyContinue |
        Where-Object {
            $_.PSObject.Properties.Name -contains "DisplayName" -and
            ($_.DisplayName -like "*Adobe*Reader*" -or $_.DisplayName -like "*Acrobat*Reader*" -or $_.DisplayName -like "*Adobe Acrobat*")
        } |
        Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation
}

$commands = @()
$wingetCommand = Get-Command winget -ErrorAction SilentlyContinue
if ($wingetCommand) { $commands += $wingetCommand }
$acrobatCommand = Get-Command AcroRd32.exe -ErrorAction SilentlyContinue
if ($acrobatCommand) { $commands += $acrobatCommand }
$commands = $commands | Select-Object Name, Source, Version

[pscustomobject]@{
    checkedAt = (Get-Date).ToString("o")
    processes = @($processes)
    programs = @($programs)
    commands = @($commands)
} | ConvertTo-Json -Depth 8
