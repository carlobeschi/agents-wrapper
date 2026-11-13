#!/bin/sh
# Start the night queue (night.js).
#   By hand, from the Terminal:   sh ~/agents-wrapper/scripts/night.sh
#   Every evening at 21:00:       launchd (scripts/night.plist, installed by
#                                 scripts/install-night.sh) runs it with --scheduled
# Keep the laptop on the charger with the lid open (the screen may switch off).
# In the morning the summary is in ~/.agent-dispatch/night/last-summary.md and,
# if the private reports clone is set up, in that repository (night-report.js).
#
# --scheduled: on battery, wait up to 30 minutes for the charger, then skip the
# night and say why in the report. On battery a Mac still sleeps: 12-13 Nov it
# went into thermal emergency sleep at 23:27 and every local call timed out.
# Only one night run at a time: a second one (by hand or by launchd) exits.
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export AGENT_DISPATCH_CONFIG="$HOME/.agent-dispatch/shows/agents.json"
cd "$(dirname "$0")/.." || exit 1
NIGHT="$HOME/.agent-dispatch/night"
mkdir -p "$NIGHT"

SCHEDULED=0
if [ "$1" = "--scheduled" ]; then SCHEDULED=1; shift; fi

LOCK="$NIGHT/running.pid"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M') a night run is already going (pid $(cat "$LOCK")): not starting another."
  exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT
trap 'exit 130' INT TERM

STAMP=$(date '+%Y-%m-%d_%H%M%S')
on_ac() { ! command -v pmset >/dev/null 2>&1 || pmset -g batt | grep -q "AC Power"; }
batt() { command -v pmset >/dev/null 2>&1 && pmset -g batt | grep -o '[0-9]*%' | head -1; }
note() { echo "$1"; echo "$1" >> "$NIGHT/launcher.txt"; }

{ echo "run $STAMP"; [ $SCHEDULED = 1 ] && echo "started by launchd at $(date '+%H:%M')" || echo "started by hand at $(date '+%H:%M')"; } > "$NIGHT/launcher.txt"

if ! on_ac; then
  if [ $SCHEDULED = 1 ]; then
    note "on battery ($(batt)): waiting up to 30 minutes for the charger"
    i=0
    while [ $i -lt 30 ] && ! on_ac; do sleep 60; i=$((i + 1)); done
    if ! on_ac; then
      note "still on battery at $(date '+%H:%M') ($(batt)): night skipped. Plug the Mac in; it runs again tomorrow at 21:00, or now with: sh ~/agents-wrapper/scripts/night.sh"
      node night-report.js
      exit 0
    fi
    note "charger connected at $(date '+%H:%M')"
  else
    note "! on battery ($(batt)): plug it in, or it may sleep and the night's local runs will time out."
  fi
else
  note "on the charger ($(batt))"
fi

GEMINI_API_KEY=$(security find-generic-password -s second-room-gemini -w 2>/dev/null) && export GEMINI_API_KEY
OPENROUTER_API_KEY=$(security find-generic-password -s openrouter-key -w 2>/dev/null) && export OPENROUTER_API_KEY
[ -n "$GEMINI_API_KEY" ] && K1=yes || K1=NO
[ -n "$OPENROUTER_API_KEY" ] && K2=yes || K2=NO
note "Keychain keys read: Gemini $K1, OpenRouter $K2"

# caffeinate keeps the Mac awake (system, disk, display idle sleep) while the
# queue runs; it still sleeps if the lid closes on battery, so keep it plugged in.
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dims node night.js "$@" 2>&1 | tee -a "$NIGHT/night.log"
else
  node night.js "$@" 2>&1 | tee -a "$NIGHT/night.log"
fi
