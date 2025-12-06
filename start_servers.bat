@echo off
REM Launch both servers via PowerShell script
set SCRIPT_DIR=%~dp0
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start_servers.ps1"
