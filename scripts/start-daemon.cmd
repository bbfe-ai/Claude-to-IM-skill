@echo off
rem ============================================================
rem  Internal launcher for the TuiTui bridge daemon (used by
rem  tuitui.bat fallback path when WMI is unavailable).
rem  Handles quoting/redirect cleanly for paths with spaces.
rem ============================================================
setlocal
set "SKILL_DIR=%~dp0.."
set "CTI_HOME=%~1"
if "%CTI_HOME%"=="" set "CTI_HOME=%USERPROFILE%\.claude-to-im"
if not exist "%CTI_HOME%\logs" mkdir "%CTI_HOME%\logs"
cd /d "%SKILL_DIR%"
node dist\daemon.mjs >> "%CTI_HOME%\logs\bridge.log" 2>&1