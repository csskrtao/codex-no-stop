@echo off
setlocal

rem Start the codex-no-stop retry proxy in the current window (for debugging).
rem Normally you never need this: codex-retry starts the proxy by itself.

set "HERE=%~dp0"
if exist "%HERE%settings.cmd" call "%HERE%settings.cmd"
if "%CODEX_RETRY_PORT%"=="" set "CODEX_RETRY_PORT=8788"

curl -s -m 2 http://127.0.0.1:%CODEX_RETRY_PORT%/__health >nul 2>&1
if not errorlevel 1 (
  echo Proxy is already running on port %CODEX_RETRY_PORT%.
  exit /b 0
)

rem The proxy reads CODEX_RETRY_UPSTREAM; settings.cmd stores it as CODEX_UPSTREAM.
if not "%CODEX_UPSTREAM%"=="" set "CODEX_RETRY_UPSTREAM=%CODEX_UPSTREAM%"
set "CODEX_RETRY_LOG=%HERE%proxy.log"

echo Starting proxy on 127.0.0.1:%CODEX_RETRY_PORT% ...
echo Upstream: %CODEX_RETRY_UPSTREAM%
echo Log:      %CODEX_RETRY_LOG%
echo Press Ctrl+C to stop.
echo.

node "%HERE%proxy\server.js"
