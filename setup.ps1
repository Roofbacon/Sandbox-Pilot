#requires -Version 5
# One-command setup for Sandbox Pilot: checks prerequisites, installs + builds the MCP
# server, and prints the ready-to-paste MCP client configuration.
#
#   .\setup.ps1                  # install + build + print config
#   .\setup.ps1 -BundleTesseract # also bundle Tesseract (needs a running Sandbox)
[CmdletBinding()]
param([switch]$BundleTesseract)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$mcp = Join-Path $root 'mcp'

Write-Host '== Sandbox Pilot setup ==' -ForegroundColor Cyan

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js not found. Install Node 18+ from https://nodejs.org and re-run.' -ForegroundColor Red
    exit 1
}
Write-Host ('Node ' + (& node --version)) -ForegroundColor Green

# 2. Windows Sandbox CLI
if (-not (Get-Command wsb -ErrorAction SilentlyContinue)) {
    Write-Host "WARNING: 'wsb' (Windows Sandbox CLI) not found. Enable Windows Sandbox (admin):" -ForegroundColor Yellow
    Write-Host '  Enable-WindowsOptionalFeature -FeatureName "Containers-DisposableClientVM" -All -Online' -ForegroundColor Yellow
}

# 3. Install + build (the package "prepare" script runs tsc, so this also builds dist).
Write-Host 'Installing dependencies and building the MCP server...'
& npm install --prefix $mcp
$dist = Join-Path $mcp 'dist\index.js'
if (-not (Test-Path $dist)) {
    Write-Host 'Build did not produce dist/index.js. Check the npm output above.' -ForegroundColor Red
    exit 1
}
Write-Host ('Built: ' + $dist) -ForegroundColor Green

# 4. Print the MCP client config (absolute path, forward slashes for JSON).
$distFwd = ($dist -replace '\\', '/')
Write-Host ''
Write-Host 'Add this to your MCP client config (Claude Desktop / Codex / etc.):' -ForegroundColor Cyan
Write-Host '{'
Write-Host '  "mcpServers": {'
Write-Host '    "sandbox-pilot": {'
Write-Host '      "command": "node",'
Write-Host ('      "args": ["' + $distFwd + '"],')
Write-Host '      "env": { "SANDBOX_TRANSPORT": "socket" }'
Write-Host '    }'
Write-Host '  }'
Write-Host '}'

# 5. Next steps
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Start a control-ready Sandbox:   .\host\SandboxBridge.ps1 prepare-socket'
Write-Host '  2. (optional) bundle OCR offline:   .\host\SandboxBridge.ps1 bundle-tesseract'
Write-Host '  3. Restart your MCP client so it loads the server.'

if ($BundleTesseract) {
    Write-Host ''
    Write-Host 'Bundling Tesseract (requires a running Sandbox)...' -ForegroundColor Cyan
    & (Join-Path $root 'host\SandboxBridge.ps1') bundle-tesseract
}
