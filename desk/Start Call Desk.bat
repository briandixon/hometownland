@echo off
REM Double-click this file to start the Call Desk (Windows).
setlocal
cd /d "%~dp0"
title Hometown Land Call Desk

set "PY="
py -3 --version >nul 2>&1
if %errorlevel%==0 set "PY=py -3"
if defined PY goto run

python --version >nul 2>&1
if %errorlevel%==0 set "PY=python"

:run
if not defined PY goto nopython

%PY% calldesk.py
echo.
echo Call Desk stopped.
pause
exit /b 0

:nopython
echo Python 3 is not installed on this PC.
echo.
echo Install it from https://www.python.org/downloads/
echo During setup, tick "Add python.exe to PATH" -- without that Windows
echo cannot find it. Then double-click this file again.
echo.
pause
exit /b 1
