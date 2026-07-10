@echo off
title Global Feeds (CORS)
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo Python not found. Install Python 3 from https://python.org
  pause
  exit /b 1
)

echo Starting Global Feeds (CORS-only, no proxy)...
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:19090/global-cors/"
python server.py
pause
