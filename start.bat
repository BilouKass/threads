@echo off
REM Double-cliquable : lance Threads Manager en mode DEV.
REM Pour la prod : start.bat -Prod
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
