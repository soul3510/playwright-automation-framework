#!/bin/bash

set -e

cd "$(dirname "$0")"

CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RESET="\033[0m"

printf "\n${CYAN}+----------------------------------------------+${RESET}\n"
printf "${CYAN}|     Playwright Automation Agent Web UI      |${RESET}\n"
printf "${CYAN}+----------------------------------------------+${RESET}\n\n"
printf "${GREEN}Open local form at http://localhost:3789${RESET}\n"
printf "${YELLOW}Keep this terminal open while the agent runs.${RESET}\n\n"

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:3789" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "http://localhost:3789" >/dev/null 2>&1 || true
fi

node web_agent_server.mjs
