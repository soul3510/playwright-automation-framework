@echo off
setlocal
echo Launching Playwright Automation Agent...
cd /d "%~dp0"

:: Cleanup Check
set /p choice="Would you like to clean up the 'generated/' folder first? (y/n): "
if /i "%choice%"=="y" (
    echo Cleaning up...
    node cleanup_generated.mjs
)

:: Start the Agent
echo 🚀 Starting Orchestrator...
node start_agent.mjs
