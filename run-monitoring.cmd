@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  echo Install Node.js through your company-approved software channel.
  pause
  exit /b 1
)

set "NODE_MAJOR="
for /f "delims=" %%V in ('node -p "Number(process.versions.node.split('.')[0])" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  echo [ERROR] The installed Node.js version could not be read.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Node.js 20 or newer is required. Installed major version: %NODE_MAJOR%
  pause
  exit /b 1
)

node "%~dp0cli\run.mjs" --open %*
set "MONITOR_EXIT=%ERRORLEVEL%"
if not "%MONITOR_EXIT%"=="0" (
  echo.
  echo Monitoring failed. Review the error shown above.
  pause
)
exit /b %MONITOR_EXIT%
