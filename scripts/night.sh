#!/bin/sh
# Start the night queue (night.js) from the Terminal before leaving the laptop:
#   sh ~/agents-wrapper/scripts/night.sh
# Keep the laptop plugged in with the lid open (the screen may switch off).
# In the morning: pbcopy < ~/.agent-dispatch/night/last-summary.md
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AGENT_DISPATCH_CONFIG="$HOME/.agent-dispatch/shows/agents.json"
GEMINI_API_KEY=$(security find-generic-password -s second-room-gemini -w 2>/dev/null) && export GEMINI_API_KEY
OPENROUTER_API_KEY=$(security find-generic-password -s openrouter-key -w 2>/dev/null) && export OPENROUTER_API_KEY
cd "$(dirname "$0")/.." || exit 1
mkdir -p "$HOME/.agent-dispatch/night"
# caffeinate keeps the Mac awake (system, disk, display idle sleep) while the
# queue runs; it still sleeps if the lid closes on battery, so keep it plugged in.
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dims node night.js "$@" 2>&1 | tee -a "$HOME/.agent-dispatch/night/night.log"
else
  node night.js "$@" 2>&1 | tee -a "$HOME/.agent-dispatch/night/night.log"
fi
