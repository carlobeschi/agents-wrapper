#!/bin/bash
# The brainstorm app on the Mac: API keys from the Keychain (never typed),
# then the page opens in the browser. Ctrl-C stops it and any run.
#   bash scripts/brainstorm.sh               Claude, Codex, Mistral (and Gemini on its own sign-in)
#   bash scripts/brainstorm.sh --gemini-key  Gemini on the API key instead (paid; when the quota is out)
# Runs are saved in ~/claude-projects/desk/brainstorm (BRAINSTORM_OUT to change it).
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
if [ -z "$AGENT_DISPATCH_CONFIG" ] && [ -f "$HOME/.agent-dispatch/shows/agents.json" ]; then
  export AGENT_DISPATCH_CONFIG="$HOME/.agent-dispatch/shows/agents.json"
fi
if k=$(security find-generic-password -s mistral-key -w 2>/dev/null); then export MISTRAL_API_KEY="$k"; fi
if [ "$1" = "--gemini-key" ] && k=$(security find-generic-password -s second-room-gemini -w 2>/dev/null); then export GEMINI_API_KEY="$k"; fi
unset k
export BRAINSTORM_OUT="${BRAINSTORM_OUT:-$HOME/claude-projects/desk/brainstorm}" BRAINSTORM_OPEN=1
exec node brainstorm/server.js
