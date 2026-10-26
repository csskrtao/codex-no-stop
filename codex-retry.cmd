@echo off
setlocal

rem codex-no-stop: run Codex through the local retry proxy.
rem config.toml is NOT modified; only the provider base_url is overridden,
rem so your own token / model / provider settings stay exactly as they are.
rem Usage: exactly like codex, e.g.  codex-retry exec "fix the bug"
rem                             or  codex-retry            (interactive TUI)

set "HERE=%~dp0"
if not exist "%HERE%settings.cmd" (
  echo [codex-no-stop] settings.cmd is missing. Run install.cmd first.
  exit /b 1
)
call "%HERE%settings.cmd"

rem Make sure the proxy is running (start it hidden if needed).
curl -s -m 2 http://127.0.0.1:%CODEX_RETRY_PORT%/__health >nul 2>&1
if errorlevel 1 (
  start "" wscript "%HERE%start-proxy-hidden.vbs"
  ping -n 3 127.0.0.1 >nul 2>&1
)

rem Codex honors the Windows system proxy. With Clash / V2Ray etc. turned on,
rem requests to 127.0.0.1 would be sent through that proxy and fail with 502,
rem so tell Codex to always reach the local proxy directly.
if defined NO_PROXY (
  set "NO_PROXY=%NO_PROXY%,127.0.0.1,localhost,::1"
) else (
  set "NO_PROXY=127.0.0.1,localhost,::1"
)
set "no_proxy=%NO_PROXY%"

call codex ^
  -c model_provider=%CODEX_PROVIDER% ^
  -c model_providers.%CODEX_PROVIDER%.base_url=http://127.0.0.1:%CODEX_RETRY_PORT%%CODEX_BASE_PATH% ^
  %*

exit /b %errorlevel%
