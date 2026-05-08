@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -Command "Write-Host ''; Write-Host '+----------------------------------------------+' -ForegroundColor Cyan; Write-Host '|     Playwright Automation Agent Web UI      |' -ForegroundColor Cyan; Write-Host '+----------------------------------------------+' -ForegroundColor Cyan; Write-Host ''; Write-Host 'Opening local form at http://localhost:3789' -ForegroundColor Green; Write-Host 'Keep this terminal open while the agent runs.' -ForegroundColor Yellow; Write-Host ''"

start "" "http://localhost:3789"
node web_agent_server.mjs
