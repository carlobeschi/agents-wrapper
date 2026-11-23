#!/bin/sh
# goal.js on the Mac, with the agent's API key read from the Keychain (never
# typed on the command line or written anywhere). Same arguments as goal.js:
#   scripts/goal.sh run ~/goals/my-goal --commit
# Keys: Anthropic in service "anthropic-key"; OpenRouter in "openrouter-key"
# (only needed if goal.json says "via": "openrouter").
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ANTHROPIC_API_KEY=$(security find-generic-password -s anthropic-key -w 2>/dev/null) && export ANTHROPIC_API_KEY
OPENROUTER_API_KEY=$(security find-generic-password -s openrouter-key -w 2>/dev/null) && export OPENROUTER_API_KEY
exec node "$(dirname "$0")/../goal.js" "$@"
