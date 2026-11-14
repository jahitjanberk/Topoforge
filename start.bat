@echo off
rem Double-click to run Topoforge locally. Opens http://localhost:8080 in your browser.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
node serve.js
pause
