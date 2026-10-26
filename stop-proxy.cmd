@echo off
setlocal

rem Stop the codex-no-stop retry proxy.

set "HERE=%~dp0"
if exist "%HERE%settings.cmd" call "%HERE%settings.cmd"
if "%CODEX_RETRY_PORT%"=="" set "CODEX_RETRY_PORT=8788"

powershell -NoProfile -Command "try { $h = Invoke-RestMethod ('http://127.0.0.1:%CODEX_RETRY_PORT%/__health') -TimeoutSec 3; Stop-Process -Id $h.pid -Force; Write-Host ('Stopped proxy, pid ' + $h.pid) } catch { Write-Host 'Proxy is not running.' }"
