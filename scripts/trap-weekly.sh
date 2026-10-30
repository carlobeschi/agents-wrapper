#!/bin/sh
# The Trap's weekly run on the Mac, for launchd (scripts/trap-weekly.plist).
# Settings: ~/.agent-dispatch/trap-weekly.json (a trap file with "number": "next",
# "repo" and "github"). It opens the episode's pull request and stops: a person
# reviews and merges it. Output goes to ~/.agent-dispatch/trap-weekly.log.
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AGENT_DISPATCH_CONFIG="$HOME/.agent-dispatch/shows/agents.json"
GEMINI_API_KEY=$(security find-generic-password -s second-room-gemini -w) && export GEMINI_API_KEY
cd "$(dirname "$0")/.." || exit 1
echo "---- $(date)"
exec node trap.js "$HOME/.agent-dispatch/trap-weekly.json" "$@"
