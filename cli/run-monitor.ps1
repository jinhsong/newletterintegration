$ErrorActionPreference = 'Stop'

$cliRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $cliRoot
$logDir = Join-Path $cliRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $logDir "monitor-$stamp.log"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 20 이상이 필요합니다.'
}

node .\run.mjs *>> $logPath
if ($LASTEXITCODE -ne 0) {
  throw "통상 모니터링 HTML 생성 실패 (exit $LASTEXITCODE) — 로그: $logPath"
}
