$ErrorActionPreference = 'Stop'

$cliRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $cliRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 20 이상이 필요합니다.'
}

node .\run.mjs --deliver
if ($LASTEXITCODE -ne 0) {
  throw "통상 모니터링 실행 실패 (exit $LASTEXITCODE)"
}
