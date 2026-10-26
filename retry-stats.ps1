# codex-no-stop: retry statistics.
#
#   -Mode watch : keep the terminal title updated while Codex runs
#   -Mode after : print a one-line summary after Codex exits
#
# Statistics come from the local proxy:  GET http://127.0.0.1:<Port>/__stats
# The wrapper creates a run file name and deletes it once Codex exits; the
# watcher uses it as its lifetime marker.

param(
  [ValidateSet('watch', 'after')][string]$Mode = 'watch',
  [int]$Port = 8788,
  [string]$RunFile = ''
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-Stats {
  try { return Invoke-RestMethod -Uri ("http://127.0.0.1:$Port/__stats") -TimeoutSec 2 } catch { return $null }
}

function Format-Local([string]$iso) {
  if (-not $iso) { return '' }
  try { return ([datetime]::Parse($iso)).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') } catch { return '' }
}

function Read-Base {
  if (-not $RunFile) { return -1 }
  try {
    $raw = Get-Content -LiteralPath $RunFile -Raw
    return [int]($raw.Trim())
  } catch { return -1 }
}

if ($Mode -eq 'watch') {
  $s = Get-Stats
  $base = 0
  if ($s) { $base = [int]$s.session_retries }
  if ($RunFile) { try { Set-Content -LiteralPath $RunFile -Value $base -Encoding ASCII } catch { } }

  $deadline = (Get-Date).AddHours(12)
  while ($true) {
    if ($RunFile -and -not (Test-Path -LiteralPath $RunFile)) { break }
    if ((Get-Date) -gt $deadline) { break }

    $s = Get-Stats
    if ($s) {
      $n = [Math]::Max(0, [int]$s.session_retries - $base)
      if ($n -gt 0) {
        $when = Format-Local $s.last_retry_at
        $clock = if ($when.Length -ge 19) { $when.Substring(11) } else { '--:--:--' }
        $text = "Codex · 重试 $n 次 · 上次 $clock"
        if ([Console]::Title -ne $text) { [Console]::Title = $text }
      }
    }
    Start-Sleep -Seconds 2
  }
  exit 0
}

# ---- -Mode after ------------------------------------------------------------
$s = Get-Stats
if (-not $s) { exit 0 }

$base = Read-Base
$run = if ($base -ge 0) { [Math]::Max(0, [int]$s.session_retries - $base) } else { [int]$s.session_retries }
$when = Format-Local $s.last_retry_at

if ($run -gt 0) {
  $line = "codex-no-stop: 本次重试 $run 次（累计 $($s.total_retries) 次），上次重试 $when"
} elseif ($s.total_retries -gt 0) {
  $line = "codex-no-stop: 本次没有重试（累计 $($s.total_retries) 次，上次 $when）"
} else {
  $line = "codex-no-stop: 还没有重试记录"
}

Write-Host ""
Write-Host $line -ForegroundColor DarkYellow
