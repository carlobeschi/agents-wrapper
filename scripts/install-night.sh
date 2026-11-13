#!/bin/sh
# Installs (or reinstalls) the launchd job that starts the night queue every
# evening at 21:00:   sh ~/agents-wrapper/scripts/install-night.sh
# Remove it:          sh ~/agents-wrapper/scripts/install-night.sh --remove
# It runs as you, in your login session, so it reads the Keychain like the
# Terminal does. The Mac must be awake at 21:00 (on the charger, lid open); if
# it is asleep then, launchd starts the run as soon as it wakes.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
P="$HOME/Library/LaunchAgents/com.agents-wrapper.night.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.agent-dispatch/night"

[ -f "$P" ] && launchctl unload "$P" 2>/dev/null
if [ "$1" = "--remove" ]; then rm -f "$P"; echo "night queue: removed from launchd"; exit 0; fi

sed "s#HOME_DIR/agents-wrapper#$REPO#; s#HOME_DIR#$HOME#g" "$REPO/scripts/night.plist" > "$P" || exit 1
plutil -lint "$P" >/dev/null || { echo "night queue: the plist is not valid"; exit 1; }
launchctl load "$P" || exit 1
launchctl list | grep -q com.agents-wrapper.night && echo "night queue: installed, it starts every evening at 21:00" || { echo "night queue: launchd did not take it"; exit 1; }

if [ -d "$HOME/.agent-dispatch/night-reports/.git" ]; then echo "reports: the summary goes to $(git -C "$HOME/.agent-dispatch/night-reports" remote get-url origin)"
else echo "reports: not set up yet (see docs/nuovo-portatile.md, 'Coda notturna da sola')"; fi
S=$(pmset -g custom | awk '/^AC Power/{ac=1} /^Battery Power/{ac=0} ac && $1=="sleep"{print $2; exit}')
[ -n "$S" ] && [ "$S" != 0 ] && echo "! on the charger the Mac goes to sleep by itself: sudo pmset -c sleep 0 keeps it awake"
exit 0
