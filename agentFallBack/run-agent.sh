#!/bin/bash

set -e

# Navigate to the agent directory.
cd "$(dirname "$0")"

CYAN="\033[36m"
YELLOW="\033[33m"
DIM_YELLOW="\033[2;33m"
GREEN="\033[32m"
RESET="\033[0m"

printf "\n${CYAN}+----------------------------------------------+${RESET}\n"
printf "${CYAN}|     Playwright Automation Agent Launcher    |${RESET}\n"
printf "${CYAN}+----------------------------------------------+${RESET}\n\n"

# Cleanup Check
printf "${YELLOW}+----------------------------------------------+${RESET}\n"
printf "${YELLOW}| Clean generated metadata before starting?    |${RESET}\n"
printf "${DIM_YELLOW}| This keeps manual scenario runs fresh.       |${RESET}\n"
printf "${YELLOW}+----------------------------------------------+${RESET}\n"
read -r -p "Choose y/n: " choice

if [[ "$choice" == "y" || "$choice" == "Y" ]]; then
    printf "${GREEN}Cleaning generated folder...${RESET}\n"
    node cleanup_generated.mjs
fi

# Start the Agent
printf "\n${GREEN}Starting Orchestrator...${RESET}\n\n"
node start_agent.mjs
