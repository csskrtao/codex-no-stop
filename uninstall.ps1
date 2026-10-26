# codex-no-stop uninstaller
# Stops the proxy and removes the global codex-retry command.
# Your config.toml was never modified, so nothing to restore there.

param([switch]$NoGlobal)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== codex-no-stop uninstaller ===" -ForegroundColor Cyan

# ---- port from settings.cmd -------------------------------------------------
$port = '8788'
$settingsPath = Join-Path $here 'settings.cmd'
if (Test-Path -LiteralPath $settingsPath) {
  $settingsText = Get-Content -LiteralPath $settingsPath -Raw
  $pm = [regex]::Match($settingsText, 'CODEX_RETRY_PORT=(\d+)')
  if ($pm.Success) { $port = $pm.Groups[1].Value }
}

# ---- stop the proxy ---------------------------------------------------------
try {
  $h = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/__health" -f $port) -TimeoutSec 3
  if ($h.pid) {
    Stop-Process -Id $h.pid -Force -ErrorAction Stop
    Write-Host ("Stopped proxy (pid {0})." -f $h.pid)
  }
} catch {
  Write-Host "Proxy is not running."
}

# ---- remove the global launcher (only if it points at this folder) ----------
if (-not $NoGlobal) {
  $npmPrefix = $null
  try { $npmPrefix = (& npm prefix -g | Select-Object -Last 1) } catch { $npmPrefix = $null }
  if ($npmPrefix) { $npmPrefix = $npmPrefix.Trim() }

  if ($npmPrefix -and $npmPrefix -match '^[A-Za-z]:\\') {
    $launcherPath = Join-Path $npmPrefix 'codex-retry.cmd'
    if (Test-Path -LiteralPath $launcherPath) {
      $content = Get-Content -LiteralPath $launcherPath -Raw
      if ($content -and $content.Contains($here)) {
        Remove-Item -LiteralPath $launcherPath -Force
        Write-Host "Removed global command: $launcherPath"
      } else {
        Write-Host "Left $launcherPath alone (it points somewhere else)."
      }
    }
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath) {
    $parts = $userPath.Split(';') | Where-Object { $_ -ne '' -and $_ -ne $here }
    $newPath = $parts -join ';'
    if ($newPath -ne $userPath) {
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
      Write-Host "Removed this folder from your user PATH."
    }
  }
}

Write-Host ""
Write-Host "Done. You can delete this folder now." -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to exit" | Out-Null
