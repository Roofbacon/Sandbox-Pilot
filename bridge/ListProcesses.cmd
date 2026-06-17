@echo off
echo %DATE% %TIME% ListProcesses.cmd invoked> C:\SandboxBridge\logs\tasklist.txt
tasklist.exe /V >> C:\SandboxBridge\logs\tasklist.txt 2>&1
exit /b 0
