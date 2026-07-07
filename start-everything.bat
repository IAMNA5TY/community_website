@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title NA5TY Dashboard Launcher

echo.
echo  ============================================
echo   NA5TY stream dashboard - start everything
echo  ============================================
echo.

REM --- Stop stale server on port 3000 ---
echo Stopping any old server on port 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

REM --- Stop stale Govee UDP listener on port 4002 (orphan node after restart) ---
echo Stopping any stale Govee listener on UDP port 4002...
for /f %%a in ('powershell -NoProfile -Command "netstat -ano ^| Select-String ':4002' ^| ForEach-Object { ($_ -split '\s+')[-1] } ^| Sort-Object -Unique"') do (
  taskkill /F /PID %%a >nul 2>&1
)

REM --- Read reserved ngrok domain from .env WEBHOOK_URL (if set) ---
set "NGROK_DOMAIN="
if exist ".env" (
  for /f "delims=" %%D in ('powershell -NoProfile -Command "$line = Get-Content '.env' | Where-Object { $_ -match '^WEBHOOK_URL=https?://' } | Select-Object -First 1; if ($line) { $u = $line -replace '^WEBHOOK_URL=',''; ([uri]$u).Host }"') do (
    set "NGROK_DOMAIN=%%D"
  )
)

REM Override here if you use a different ngrok domain than .env:
REM set NGROK_DOMAIN=your-name.ngrok-free.dev

where ngrok >nul 2>&1
if errorlevel 1 (
  echo WARNING: ngrok not found in PATH. Install from https://ngrok.com/download
  echo          Kick webhooks/chat will not work until ngrok is running.
  echo.
  set "SKIP_NGROK=1"
) else (
  set "SKIP_NGROK=0"
)

if "%SKIP_NGROK%"=="0" (
  echo Stopping any old ngrok processes...
  taskkill /F /IM ngrok.exe >nul 2>&1

  if defined NGROK_DOMAIN (
    echo Starting ngrok tunnel: https://!NGROK_DOMAIN! -^> localhost:3000
    start "ngrok tunnel" cmd /k "cd /d "%~dp0" & ngrok http 3000 --domain=!NGROK_DOMAIN!"
  ) else (
    echo Starting ngrok tunnel: localhost:3000 ^(random URL - update WEBHOOK_URL in .env^)
    start "ngrok tunnel" cmd /k "cd /d "%~dp0" & ngrok http 3000"
  )
  timeout /t 2 /nobreak >nul
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting dashboard at http://localhost:3000
echo.
echo  Before lighting sync:
echo    - Close GoveeLAN on this PC ^(UDP port 4002^)
echo    - Close Lumia Stream if using dashboard Hue beat sync
echo.
echo  Keep the server window open while streaming.
echo  Press Ctrl+C in the server window to stop.
echo.

start "NA5TY Dashboard" cmd /k "cd /d "%~dp0" & node server.js"

timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"

echo.
echo Launched:
if "%SKIP_NGROK%"=="0" echo   - ngrok tunnel window
echo   - dashboard server window
echo   - browser tab
echo.
pause
