@echo off
REM Right-click this file and choose "Run as administrator".
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
