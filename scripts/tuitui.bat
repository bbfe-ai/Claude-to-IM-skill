@echo off
setlocal EnableExtensions
rem ============================================================
rem  TuiTui (推推) channel - pure cmd entry (no PowerShell required)
rem
rem  Usage:
rem    tuitui.bat install [-AutoApprove] [-Workdir DIR]
rem    tuitui.bat start | stop | status | logs
rem    tuitui.bat install-service | uninstall-service
rem
rem  install            one-click install: env check -> deps -> config
rem                     -> build -> start (interactive credential prompt)
rem  start/stop/status  manage the bridge daemon (WMI-based PID tracking)
rem  logs               show the bridge log
rem  install-service    autostart at boot via Task Scheduler (schtasks)
rem ============================================================

set "SKILL_DIR=%~dp0.."
if not defined CTI_HOME set "CTI_HOME=%USERPROFILE%\.claude-to-im"
set "CONFIG=%CTI_HOME%\config.env"
set "LOG=%CTI_HOME%\logs\bridge.log"
set "RUN=%CTI_HOME%\runtime"
set "PIDFILE=%RUN%\bridge.pid"
set "NODE=node"

set "CMD=%~1"
if "%CMD%"=="" goto usage

rem ---------- install ----------
if /I "%CMD%"=="install" goto install

rem ---------- start / stop / status / logs ----------
if /I "%CMD%"=="start" goto start_bridge
if /I "%CMD%"=="stop" goto stop_bridge
if /I "%CMD%"=="status" goto status_bridge
if /I "%CMD%"=="logs" goto show_logs
if /I "%CMD%"=="install-service" goto install_service
if /I "%CMD%"=="uninstall-service" goto uninstall_service

:usage
echo TuiTui channel management for claude-to-im-skill (pure cmd, no PowerShell)
echo.
echo Usage:
echo   tuitui.bat install [-AutoApprove] [-Workdir DIR]
echo   tuitui.bat start ^| stop ^| status ^| logs
echo   tuitui.bat install-service ^| uninstall-service
exit /b 1

rem ============================================================
rem  INSTALL
rem ============================================================
:install
echo ==^> Checking environment...
where node >nul 2>&1 || (echo ERROR: node not found, install Node.js ^>= 20 first & exit /b 1)
where claude >nul 2>&1 || (echo ERROR: claude CLI not found & exit /b 1)
where git >nul 2>&1 || (echo ERROR: git not found & exit /b 1)
for /f "delims=" %%v in ('node -v') do echo      Node %%v / claude CLI / git OK

echo ==^> Checking dependencies...
if exist "%SKILL_DIR%\node_modules\claude-to-im" (
    echo      Dependencies ready.
) else if exist "%SKILL_DIR%\..\Claude-to-IM" (
    echo      Upstream repo found, running npm install...
    pushd "%SKILL_DIR%"
    call npm install
    popd
) else (
    if not defined CTI_UPSTREAM_REPO set "CTI_UPSTREAM_REPO=https://github.com/bbfe-ai/Claude-to-IM"
    echo      Cloning %CTI_UPSTREAM_REPO% ...
    git clone --depth 1 "%CTI_UPSTREAM_REPO%" "%SKILL_DIR%\..\Claude-to-IM"
    pushd "%SKILL_DIR%"
    call npm install
    popd
)

echo ==^> Config (%CONFIG%)
if not exist "%CTI_HOME%" mkdir "%CTI_HOME%"
if exist "%CONFIG%" (
    choice /C YN /M "config.env already exists - rebuild it (Y/N)"
    if errorlevel 2 goto config_keep
)
if not exist "%RUN%" mkdir "%RUN%"
set /p TUITUI_APPID="TuiTui App ID: "
set /p TUITUI_SECRET="TuiTui Secret: "
set /p TUITUI_BOTNAME="TuiTui bot name: "
set "WORKDIR="
set "PREV="
for %%a in (%*) do (
    if /I "%%a"=="-Workdir" (set "PREV=workdir") else if defined PREV (set "WORKDIR=%%a" & set "PREV=")
)
if not defined WORKDIR set "WORKDIR=%USERPROFILE%\agent-workspace"
(
echo CTI_RUNTIME=claude
echo CTI_ENABLED_CHANNELS=tuitui
echo CTI_DEFAULT_WORKDIR=%WORKDIR%
echo CTI_TUITUI_API_BASE=https://alarm.im.qihoo.net
echo CTI_TUITUI_CARD_URL=https://intent-os.qihoo.net
echo CTI_TUITUI_MEDIA_ENABLED=true
echo CTI_TUITUI_APPID=%TUITUI_APPID%
echo CTI_TUITUI_SECRET=%TUITUI_SECRET%
echo CTI_TUITUI_BOT_NAME=%TUITUI_BOTNAME%
echo %* | findstr /i "AutoApprove" >nul && echo CTI_AUTO_APPROVE=true
) > "%CONFIG%"
:config_keep

echo ==^> Building daemon bundle...
pushd "%SKILL_DIR%"
call npm run build
popd
if not exist "%SKILL_DIR%\dist\daemon.mjs" (echo ERROR: build failed & exit /b 1)

echo ==^> Starting bridge...
call :do_start
echo.
echo OK - deployment finished. Check log: %LOG%
echo Management: tuitui.bat start ^| stop ^| status ^| logs
exit /b 0

rem ============================================================
rem  START
rem ============================================================
:start_bridge
call :is_running
if defined RUNNING_PID (echo Bridge already running ^(PID %RUNNING_PID%^) & exit /b 1)
call :do_start
exit /b 0

:do_start
if not exist "%RUN%" mkdir "%RUN%"
if not exist "%CTI_HOME%\logs" mkdir "%CTI_HOME%\logs"
echo Starting bridge daemon...
rem WMI-based PID tracking (Windows 7-10). Fallback to titled window below.
rem Note: "" inside the wmic command line collapses to a single quote for
rem the CommandLine argument (handles spaces in paths).
for /f "tokens=2 delims==; " %%a in ('wmic process call create "node ""%SKILL_DIR%\dist\daemon.mjs""" ^| findstr /i "ProcessId"') do set "NEWPID=%%a"
if defined NEWPID (
    echo %NEWPID% > "%PIDFILE%"
    echo Started ^(PID %NEWPID%^). Log: %LOG%
) else (
    rem WMI unavailable - start via wrapper cmd with a titled window
    start "TuituiBridge" /min "%SKILL_DIR%\scripts\start-daemon.cmd" "%CTI_HOME%"
    echo Started ^(WMI unavailable, stop via: taskkill /FI "WINDOWTITLE eq TuituiBridge*"^)
)
exit /b 0

rem ============================================================
rem  STOP
rem ============================================================
:stop_bridge
if not exist "%PIDFILE%" (echo No bridge running & exit /b 0)
set /p OLDPID=<"%PIDFILE%"
tasklist /FI "PID eq %OLDPID%" 2>nul | findstr /i "%OLDPID%" >nul
if errorlevel 1 (echo Bridge was not running ^(stale PID file^) & del "%PIDFILE%" & exit /b 0)
taskkill /PID %OLDPID% /F >nul 2>&1
del "%PIDFILE%" 2>nul
echo Bridge stopped
exit /b 0

rem ============================================================
rem  STATUS
rem ============================================================
:status_bridge
call :is_running
if defined RUNNING_PID (
    echo Bridge is running ^(PID %RUNNING_PID%^)
    exit /b 0
)
echo Bridge is not running
exit /b 1

:is_running
set "RUNNING_PID="
if not exist "%PIDFILE%" exit /b 0
set /p RUNNING_PID=<"%PIDFILE%"
tasklist /FI "PID eq %RUNNING_PID%" 2>nul | findstr /i "%RUNNING_PID%" >nul
if errorlevel 1 set "RUNNING_PID="
exit /b 0

rem ============================================================
rem  LOGS
rem ============================================================
:show_logs
if not exist "%LOG%" (echo No log file yet: %LOG% & exit /b 1)
echo ----- %LOG%
type "%LOG%"
exit /b 0

rem ============================================================
rem  SERVICE (autostart via Task Scheduler - pure cmd)
rem ============================================================
:install_service
if not defined CTI_TUITUI_SERVICE set "CTI_TUITUI_SERVICE=ClaudeToIM-Tuitui"
for /f "delims=" %%n in ('where node') do set "NODEPATH=%%n"
if not defined NODEPATH (echo ERROR: node not found & exit /b 1)
schtasks /create /tn "%CTI_TUITUI_SERVICE%" /tr "\"%NODEPATH%\" \"%SKILL_DIR%\dist\daemon.mjs\"" /sc onstart /ru SYSTEM /rl highest /f
if errorlevel 1 (echo ERROR: schtasks create failed & exit /b 1)
echo Service task "%CTI_TUITUI_SERVICE%" installed - runs at system startup.
echo Manual run: schtasks /run /tn "%CTI_TUITUI_SERVICE%"
exit /b 0

:uninstall_service
if not defined CTI_TUITUI_SERVICE set "CTI_TUITUI_SERVICE=ClaudeToIM-Tuitui"
schtasks /delete /tn "%CTI_TUITUI_SERVICE%" /f
echo Service task removed.
exit /b 0