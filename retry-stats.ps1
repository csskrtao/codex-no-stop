# codex-no-stop: retry statistics.
#
#   -Mode watch : show a small always-on-top overlay while Codex runs
#   -Mode after : print a one-line summary after Codex exits
#
# Codex's own status bar (the line under the input box) only accepts its
# built-in items and has no slot for custom text, so the live counter is drawn
# in a separate frameless overlay pinned to the bottom centre of the screen.
# The terminal title is never touched.
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
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexNoStopNative {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
"@

  $s = Get-Stats
  $base = 0
  if ($s) { $base = [int]$s.session_retries }
  if ($RunFile) { try { Set-Content -LiteralPath $RunFile -Value $base -Encoding ASCII } catch { } }

  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = 'None'
  $form.TopMost = $true
  $form.ShowInTaskbar = $false
  $form.StartPosition = 'Manual'
  $form.BackColor = [System.Drawing.Color]::FromArgb(28, 30, 34)
  $form.Opacity = 0.92
  $form.Width = 300
  $form.Height = 30
  $form.Text = 'codex-no-stop'

  $label = New-Object System.Windows.Forms.Label
  $label.Dock = 'Fill'
  $label.TextAlign = 'MiddleCenter'
  $label.ForeColor = [System.Drawing.Color]::FromArgb(240, 196, 110)
  $label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
  $label.Text = 'Codex · 重试 0 次'
  $form.Controls.Add($label)

  $place = {
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Left = $wa.Left + [int](($wa.Width - $form.Width) / 2)
    $form.Top = $wa.Bottom - $form.Height - 8
  }
  & $place

  $deadline = (Get-Date).AddHours(12)
  $tick = {
    if ($RunFile -and -not (Test-Path -LiteralPath $RunFile)) { $form.Close(); return }
    if ((Get-Date) -gt $deadline) { $form.Close(); return }

    $st = Get-Stats
    if ($st) {
      $n = [Math]::Max(0, [int]$st.session_retries - $base)
      $when = Format-Local $st.last_retry_at
      if ($n -gt 0 -and $when.Length -ge 19) {
        $label.Text = "Codex · 重试 $n 次 · 上次 $($when.Substring(11))"
      } else {
        $label.Text = 'Codex · 重试 0 次'
      }
    }
    & $place
  }

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 500
  $timer.Add_Tick($tick)

  $form.Add_Shown({
    # Click-through + no focus stealing, so the overlay never gets in the way.
    # Note: WS_EX_LAYERED is already set by Opacity; re-setting that bit would
    # reset the alpha to 0 and make the window invisible, so only add the rest.
    $ex = [CodexNoStopNative]::GetWindowLong($form.Handle, -20)
    $null = [CodexNoStopNative]::SetWindowLong($form.Handle, -20, $ex -bor 0x20 -bor 0x80 -bor 0x08000000)
    $form.Opacity = 0.92
    & $tick
    $timer.Start()
  })

  [System.Windows.Forms.Application]::Run($form)
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
