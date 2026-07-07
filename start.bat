@echo off
cd /d "%~dp0"

echo Stopping any old server on port 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

echo Stopping any stale Govee listener on UDP port 4002...
for /f %%a in ('powershell -NoProfile -Command "netstat -ano ^| Select-String ':4002' ^| ForEach-Object { ($_ -split '\s+')[-1] } ^| Sort-Object -Unique"') do (
  taskkill /F /PID %%a >nul 2>&1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
)

echo.
echo Starting NA5TY stream dashboard at http://localhost:3000
echo Press Ctrl+C to stop.
echo.

node server.js
