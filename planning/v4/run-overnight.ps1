# Overnight runner for Claude Code (v4 own AI price engine)
# Runs Claude Code in print mode, and when a run ends (finished a chunk, hit a
# usage limit, or crashed) waits and starts it again. Every run resumes from
# docs/PROGRESS_V4.md. Stops at STATUS: COMPLETE / STATUS: BLOCKED, or at $StopAt.
#
# Usage (PowerShell, from D:\luggage-watch-main):
#   powershell -ExecutionPolicy Bypass -File planning\v4\run-overnight.ps1
#   (optional) -StopAt "08:30"

param([string]$StopAt = "08:30")

$ErrorActionPreference = "Continue"
Set-Location "D:\luggage-watch-main"
$progress = "docs\PROGRESS_V4.md"
$log = "planning\v4\overnight.log"
$prompt = "Read planning/v4/OVERNIGHT_PROMPT.md and follow it exactly. Resume from docs/PROGRESS_V4.md if it exists. The owner is asleep: never wait for answers, log assumptions and keep going. Never commit, push or merge."

$stop = [datetime]::ParseExact($StopAt, "HH:mm", $null)
if ($stop -lt (Get-Date)) { $stop = $stop.AddDays(1) }

function Status {
  if (Test-Path $progress) { (Get-Content $progress -TotalCount 1) } else { "STATUS: NOT STARTED" }
}

$run = 0
while ((Get-Date) -lt $stop) {
  $s = Status
  if ($s -match "^STATUS: (COMPLETE|BLOCKED)") { "$(Get-Date -f s) $s - stopping." | Tee-Object -Append $log; break }

  $run++
  $started = Get-Date
  "$(Get-Date -f s) run $run starting ($s)" | Tee-Object -Append $log
  claude -p $prompt --permission-mode auto --output-format text 2>&1 | Tee-Object -Append $log
  $mins = ((Get-Date) - $started).TotalMinutes
  "$(Get-Date -f s) run $run ended after $([math]::Round($mins,1)) min" | Tee-Object -Append $log

  # A very short run usually means a usage limit or an error: wait longer.
  $wait = if ($mins -lt 3) { 30 } else { 5 }
  if ((Get-Date).AddMinutes($wait) -ge $stop) { break }
  "$(Get-Date -f s) waiting $wait min before the next run" | Tee-Object -Append $log
  Start-Sleep -Seconds ($wait * 60)
}
"$(Get-Date -f s) done. Last status: $(Status)" | Tee-Object -Append $log
