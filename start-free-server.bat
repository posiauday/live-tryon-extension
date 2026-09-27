@echo off
rem Starts the local try-on server for the extension's Free mode. Leave this window open while you use Free mode.
rem   start-free-server.bat            -> demo engine (pastes the garment onto your photo; no AI, no downloads)
rem   start-free-server.bat catvton    -> real AI (CatVTON); see server\README.md for the one-time setup
cd /d "%~dp0"
if /i "%1"=="catvton" (
  python server\tryon_server.py --engine catvton --catvton-dir "%~dp0..\CatVTON" --precision fp16
) else (
  python server\tryon_server.py
)
pause
