#!/bin/sh
# The Motion's morning run on the Mac, for launchd (scripts/motion-daily.plist).
# Output goes to ~/.agent-dispatch/motion-daily.log.
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AGENT_DISPATCH_CONFIG="$HOME/.agent-dispatch/shows/agents.json"
GEMINI_API_KEY=$(security find-generic-password -s second-room-gemini -w) && export GEMINI_API_KEY
cd "$(dirname "$0")/.." || exit 1
echo "---- $(date)"
exec node motion-daily.js "$@"
