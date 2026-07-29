param(
  [string]$TaskName = 'TradeMonitoring-GeminiCLI',
  [string]$At = '08:35'
)

$ErrorActionPreference = 'Stop'
$runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-monitor.ps1')).Path
$workingDirectory = Split-Path -Parent $runner

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$runner`"" `
  -WorkingDirectory $workingDirectory
$trigger = New-ScheduledTaskTrigger `
  -Weekly `
  -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
  -At $At
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description '사내 Gemini CLI로 관세·수출통제·무역구제 통합 뉴스레터 수집' `
  -Force

Write-Host "작업 스케줄러 등록 완료: $TaskName / 평일 $At"
