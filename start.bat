@echo off
setlocal
cd /d "%~dp0"
if not exist "gopostman.exe" (
  echo Building gopostman.exe ...
  go build -o gopostman.exe .
  if errorlevel 1 (
    echo Build failed. Make sure Go is installed.
    pause
    exit /b 1
  )
)
echo.
echo   GoPostman  ->  http://127.0.0.1:8080
echo   No login required. All data stays on this machine.
echo   Press Ctrl+C to stop.
echo.
gopostman.exe %*
