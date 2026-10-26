:: SPDX-License-Identifier: GPL-3.0-or-later
@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title ZeroScript Bridge — KEEP OPEN
cd /d "%~dp0"

if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>nul
set "LOGFILE=%~dp0logs\start.log"
call :log "===== %DATE% %TIME%  start.bat launched ====="
for /f "tokens=*" %%v in ('ver') do call :log "%%v"

echo.
echo   === ZeroScript Bridge v2.2 — KEEP THIS WINDOW OPEN ===
echo   Do NOT close this window ^— ZeroScript stops if you do.
echo.

if not exist "%~dp0bridge.py" (
    echo   ERROR: bridge.py not found next to start.bat.
    echo   If you opened start.bat from inside the ZIP, first EXTRACT
    echo   the whole ZIP (right-click, Extract All...), then run start.bat
    echo   from the extracted folder.
    call :log "FATAL: bridge.py missing"
    goto :keep_open
)

:find_python
echo   [1/3] Looking for Python...
set "PY="
where py >nul 2>nul && set "PY=py -3"
call :validate_py && goto :found
set "PY=python"
call :validate_py && goto :found
for %%R in (
    "%LOCALAPPDATA%\Programs\Python"
    "%ProgramFiles%"
    "%ProgramFiles(x86)%"
) do (
    if exist "%%~R" (
        for /f "delims=" %%D in ('dir /b /ad /o-n "%%~R\Python3*" 2^>nul') do (
            if exist "%%~R\%%D\python.exe" (
                set PY="%%~R\%%D\python.exe"
                call :validate_py && goto :found
            )
        )
    )
)
goto :need_install

:found
for /f "tokens=*" %%v in ('call %PY% --version 2^>^&1') do (
    echo         Found: %PY%  (%%v^)
    call :log "Python found: %PY% (%%v)"
)
goto :install_deps

:need_install
where winget >nul 2>nul
if errorlevel 1 (
    echo   ERROR: Python not installed and winget not available.
    echo   Install Python: https://www.python.org/downloads/
    echo   Tick "Add python.exe to PATH" then run start.bat again.
    call :log "FATAL: no Python and no winget"
    goto :keep_open
)
echo         Not found. Installing via winget...
winget install --id Python.Python.3.12 --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 call :log "winget install error"
echo   Checking again...
set "PY=py -3"
call :validate_py && goto :ready
set "PY=python"
call :validate_py && goto :ready
for %%R in (
    "%LOCALAPPDATA%\Programs\Python"
    "%ProgramFiles%"
    "%ProgramFiles(x86)%"
) do (
    if exist "%%~R" (
        for /f "delims=" %%D in ('dir /b /ad /o-n "%%~R\Python3*" 2^>nul') do (
            if exist "%%~R\%%D\python.exe" (
                set PY="%%~R\%%D\python.exe"
                call :validate_py && goto :ready
            )
        )
    )
)
echo   ERROR: Python not found after install. Install manually and tick ADD TO PATH.
call :log "FATAL: no Python after winget"
goto :keep_open
:ready
echo         Python ready!
call :log "Python ready after winget: %PY%"

:install_deps
echo.
echo   [2/3] Checking dependencies (websockets + ultra) ...
%PY% -c "import websockets" >nul 2>nul
if errorlevel 1 (
    echo         Installing websockets (first time only)...
    %PY% -m pip install --user websockets
    if errorlevel 1 (
        echo   ERROR: Could not install websockets. Check internet/firewall.
        echo   Or use Microsoft Store Python — install from python.org instead.
        call :log "FATAL: pip install websockets failed"
        goto :keep_open
    )
)
echo         websockets OK
call :log "websockets OK"
%PY% -c "import orjson" >nul 2>nul
if errorlevel 1 (
    echo         Installing orjson (optional, +30%% speed) ...
    %PY% -m pip install --user orjson >nul 2>nul
    if not errorlevel 1 echo         orjson OK & call :log "orjson installed"
)
%PY% -c "import msgpack" >nul 2>nul
if errorlevel 1 (
    echo         Installing msgpack (optional) ...
    %PY% -m pip install --user msgpack >nul 2>nul
    if not errorlevel 1 echo         msgpack OK & call :log "msgpack installed"
)

echo.
echo   [3/3] Starting bridge...
echo   Using Python: %PY%
echo   Bridge file: "%~dp0bridge.py"
echo.

REM Kill ONLY old bridge processes, not random apps on those ports
for %%P in (17613 17614) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :%%P ^| findstr LISTENING 2^>nul') do (
        for /f "tokens=1" %%n in ('powershell -NoProfile -Command "$p=Get-Process -Id %%a -EA SilentlyContinue; $p.Name" 2^>nul') do (
            echo        Checking port %%P pid %%a (%%n)...
            if /I "%%n"=="python" (
                echo        Killing old bridge pid %%a on port %%P...
                taskkill /F /PID %%a >nul 2>nul
                timeout /t 1 /nobreak >nul
            ) else (
                echo        Port %%P held by %%n (not python) — leaving it alone.
            )
        )
    )
)

echo.
echo  ############################################################
echo  ##                                                        ##
echo  ##   KEEP THIS WINDOW OPEN - DO NOT CLOSE IT              ##
echo  ##   Minimize it if you want, but leave it running.       ##
echo  ##   ZeroScript needs it to talk to Roblox Studio.         ##
echo  ##                                                        ##
echo  ##   If this window closes by itself, double-click         ##
echo  ##   start.bat again. Do NOT run it inside a browser tab. ##
echo  ##                                                        ##
echo  ############################################################
echo.
call :log "Launching bridge.py with %PY%"

REM IMPORTANT: run bridge in this window, not a new tab/window
REM Use cmd /c to keep parent window alive even if Python crashes
:run_bridge
%PY% "%~dp0bridge.py"
set "BRIDGE_EXIT=%errorlevel%"
call :log "bridge.py exited with code %BRIDGE_EXIT%"

echo.
if "%BRIDGE_EXIT%"=="0" (
    echo   Bridge stopped normally. (code 0)
    echo   If you closed it on purpose, you can now close this window.
    goto :keep_open
)
if "%BRIDGE_EXIT%"=="1073807364" (
    echo   Bridge crashed with code 1073807364 — this is usually a Python/
    echo   websockets mismatch on Python 3.14. Fix:
    echo   1) Run:  py -3 -m pip install --upgrade --user websockets
    echo   2) Or install Python 3.12 from python.org and tick ADD TO PATH
    echo   Then double-click start.bat again.
    call :log "Exit 1073807364 — Python/websockets mismatch (try upgrade websockets or use Python 3.12)"
    goto :keep_open
)
echo   Bridge stopped with ERROR code %BRIDGE_EXIT% — scroll up for Python error.
echo   Copy this whole window + logs/start.log when asking for help.
echo   Will auto-restart in 3 seconds — close this window to stop.
timeout /t 3 /nobreak >nul
echo   Restarting bridge...
goto :run_bridge

:keep_open
echo.
echo   ────────────────────────────────────────────────
echo   This window will stay open. Press any key to close it.
echo   Logs: logs/start.log and logs/bridge_debug.log
echo   ────────────────────────────────────────────────
pause >nul
exit /b 0

:validate_py
%PY% -m pip --version >nul 2>nul || exit /b 1
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
exit /b %errorlevel%

:log
>>"%LOGFILE%" 2>nul echo(%~1
exit /b 0
