@echo off
title Metis Weather Feeds
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo Python not found. Install Python 3 from https://python.org
  pause
  exit /b 1
)

echo Starting Metis Weather Feeds...
echo Open http://127.0.0.1:19090 if the browser does not open automatically.
python server.py
pause
