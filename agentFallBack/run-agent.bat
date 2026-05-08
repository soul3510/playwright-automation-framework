@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -Command "Write-Host ''; Write-Host '+----------------------------------------------+' -ForegroundColor Cyan; Write-Host '|     Playwright Automation Agent Launcher    |' -ForegroundColor Cyan; Write-Host '+----------------------------------------------+' -ForegroundColor Cyan; Write-Host ''"

:: Cleanup Check
powershell -NoProfile -Command "Write-Host '+----------------------------------------------+' -ForegroundColor Yellow; Write-Host '| Clean generated metadata before starting?    |' -ForegroundColor Yellow; Write-Host '| This keeps manual scenario runs fresh.       |' -ForegroundColor DarkYellow; Write-Host '+----------------------------------------------+' -ForegroundColor Yellow"
set /p choice="Choose y/n: "
if /i "%choice%"=="y" (
    powershell -NoProfile -Command "Write-Host 'Cleaning generated folder...' -ForegroundColor Green"
    node cleanup_generated.mjs
)

:: Start the Agent
powershell -NoProfile -Command "Write-Host ''; Write-Host 'Starting Orchestrator...' -ForegroundColor Green; Write-Host ''"
node start_agent.mjs
