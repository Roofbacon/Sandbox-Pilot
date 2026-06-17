@echo off
echo %DATE% %TIME% KillPowerShellProcesses.cmd invoked>> C:\SandboxBridge\logs\kill-powershell.cmd.log
taskkill.exe /F /T /IM powershell.exe >> C:\SandboxBridge\logs\kill-powershell.cmd.log 2>&1
exit /b 0
