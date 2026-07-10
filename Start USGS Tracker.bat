@echo off
title USGS Tracker
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo Python not found. Install Python 3 from https://python.org
  pause
  exit /b 1
)

echo Starting USGS Tracker...
echo (Share this folder with colleagues — see SHARING.txt)
python server.py
pause
