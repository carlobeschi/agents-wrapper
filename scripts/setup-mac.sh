#!/bin/sh
# Set up a new Mac for the studio, after cloning this repo to ~/agents-wrapper:
#   sh ~/agents-wrapper/scripts/setup-mac.sh                check, and set up what is safe to set up
#   sh ~/agents-wrapper/scripts/setup-mac.sh --models       also pull the Ollama models (~13 GB)
#   sh ~/agents-wrapper/scripts/setup-mac.sh --schedule     also install the launchd jobs (Motion, Trap, night queue at 21:00)
# Install the schedule only once the old laptop's jobs are unloaded, or The Motion runs twice.
# It never reads a Keychain secret (it only checks the item exists), never loosens an
# agent's permissions and never overwrites a file that is already there.
cd "$(dirname "$0")/.." || exit 1
REPO="$PWD"
D="$HOME/.agent-dispatch"
ok()   { printf '  ok    %s\n' "$1"; }
todo() { printf '  TODO  %s\n' "$1"; TODOS=$((TODOS + 1)); }
TODOS=0

echo "Paths"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ok "PATH has ~/.local/bin" ;;
  *) todo "add to ~/.zprofile:  export PATH=\"\$HOME/.local/bin:\$HOME/.local/node/bin:\$PATH\"  (then open a new Terminal)" ;;
esac
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "Tools"
for t in node git gh claude agy codex ollama; do
  if command -v "$t" >/dev/null; then ok "$t ($(command -v "$t"))"; else todo "install $t"; fi
done

echo "Sign-ins (each opens its own login if needed: run them by hand)"
command -v gh >/dev/null && { gh auth status >/dev/null 2>&1 && ok "gh signed in" || todo "gh auth login"; }
echo "  check by hand: claude (run 'claude', /login), agy (run 'agy'), codex (run 'codex login')"

echo "Keychain (checked, never read)"
for k in second-room-gemini openrouter-key; do
  if security find-generic-password -s "$k" >/dev/null 2>&1; then ok "$k"
  else todo "security add-generic-password -a \"\$USER\" -s $k -w   (it asks for the key; never paste it in a chat)"; fi
done

echo "Settings in ~/.agent-dispatch"
mkdir -p "$D/shows" "$D/night"
if [ -f "$D/shows/agents.json" ]; then ok "shows/agents.json"
else cp examples/setup/agents.shows.json "$D/shows/agents.json" && ok "shows/agents.json copied from examples/setup"; fi
for f in motion-daily.json trap-weekly.json; do
  [ -f "$D/$f" ] && ok "$f" || todo "$f missing: restore the backup (tar -xzf studio-backup-*.tgz -C ~)"
done
[ -f "$D/night/state.json" ] && ok "night/state.json (night queue keeps its done jobs)" || todo "night/state.json missing: without it the night queue reruns every job"

echo "Checkouts"
[ -d "$HOME/the-motion/.git" ] && ok "~/the-motion" || todo "git clone https://github.com/carlobeschi/model-behaviour.git ~/the-motion"
[ -d "$D/trap-site/.git" ] && ok "~/.agent-dispatch/trap-site" || todo "git clone https://github.com/carlobeschi/model-behaviour.git ~/.agent-dispatch/trap-site"
if [ -d node_modules ]; then ok "node_modules"; else npm ci && ok "npm ci"; fi
# The judges see drawings as pictures, drawn by Playwright's Chromium.
if node -e "require('@playwright/test').chromium.launch().then(b => b.close()).catch(() => process.exit(1))" 2>/dev/null; then ok "Chromium for pictures"
else npx playwright install chromium && ok "Chromium for pictures (installed)"; fi

echo "Ollama models"
if command -v ollama >/dev/null; then
  for m in qwen3:8b gemma3:12b; do
    if ollama list 2>/dev/null | grep -q "^$m"; then ok "$m"
    elif [ "$1" = "--models" ] || [ "$2" = "--models" ]; then ollama pull "$m" && ok "$m pulled"
    else todo "ollama pull $m   (or rerun with --models)"; fi
  done
fi

echo "Schedule (launchd)"
for job in motion-daily trap-weekly night; do
  P="$HOME/Library/LaunchAgents/com.agents-wrapper.$job.plist"
  if [ -f "$P" ]; then ok "$job installed"
  elif [ "$1" = "--schedule" ] || [ "$2" = "--schedule" ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    sed "s#HOME_DIR/agents-wrapper#$REPO#; s#HOME_DIR#$HOME#g" "scripts/$job.plist" > "$P" && launchctl load "$P" && ok "$job installed"
  else todo "$job not scheduled (rerun with --schedule once the old laptop's job is unloaded)"; fi
done
if [ -d "$HOME/.agent-dispatch/night-reports/.git" ]; then ok "night reports clone"
else todo "night reports clone (private repo, see docs/nuovo-portatile.md)"; fi
echo "  the Mac must wake for The Motion: sudo pmset repeat wakeorpoweron MTWRF 07:55:00"

echo
[ "$TODOS" -eq 0 ] && echo "All set." || echo "$TODOS things left (TODO above)."
