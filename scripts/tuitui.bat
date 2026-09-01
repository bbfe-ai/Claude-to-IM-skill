@echo off
setlocal
rem ============================================================
rem  TuiTui (推推) channel entry - Windows cmd
rem
rem  Usage:
rem    tuitui.bat install [-AutoApprove] [-Workdir DIR] [-Interactive] [-CtiHome DIR]
rem    tuitui.bat start | stop | status | logs [N]
rem    tuitui.bat install-service | uninstall-service
rem
rem  install            one-click install (delegates to install-tuitui-win.ps1)
rem  start/stop/status  manage the bridge daemon (delegates to daemon.ps1)
rem  logs [N]           tail the bridge log
rem  install-service    register WinSW/NSSM autostart service
rem ============================================================

set "CMD=%~1"
if "%CMD%"=="" goto usage

if /I "%CMD%"=="install" (
    powershell -ExecutionPolicy Bypass -File "%~dp0install-tuitui-win.ps1" %2 %3 %4 %5 %6
    exit /b %errorlevel%
)

rem start|stop|status|logs|install-service|uninstall-service -> daemon.ps1
powershell -ExecutionPolicy Bypass -File "%~dp0daemon.ps1" %*
exit /b %errorlevel%

:usage
echo TuiTui channel management for claude-to-im-skill
echo.
echo Usage:
echo   tuitui.bat install [-AutoApprove] [-Workdir DIR] [-Interactive] [-CtiHome DIR]
echo   tuitui.bat start ^| stop ^| status ^| logs [N]
echo   tuitui.bat install-service ^| uninstall-service
exit /b 1
