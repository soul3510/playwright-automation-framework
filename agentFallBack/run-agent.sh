#!/bin/bash

# Navigate to the agent directory
cd "$(dirname "$0")/agentFallBack"

echo "Launching Playwright Automation Agent..."

# Cleanup Check
read -p "Would you like to clean up the 'generated/' folder first? (y/n): " choice

if [[ "$choice" == "y" || "$choice" == "Y" ]]; then
    echo "Cleaning up..."
    node cleanup_generated.mjs
fi

# Start the Agent
echo "🚀 Starting Orchestrator..."
node start_agent.mjs