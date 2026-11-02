@echo off
rem Builds the portable "SYNTHOA.exe" and a zip of it (see build.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
echo.
pause
