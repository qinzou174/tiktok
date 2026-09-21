@echo off
cd /d "%~dp0"
start "拾光解析台服务" cmd /k npm start
timeout /t 2 /nobreak >nul
start "" http://localhost:4173
