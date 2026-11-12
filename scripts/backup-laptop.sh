#!/bin/sh
# Back up what lives only on this laptop (not in git) before moving to a new one:
#   sh ~/agents-wrapper/scripts/backup-laptop.sh      -> ~/studio-backup-YYYY-MM-DD.tgz
# Run it when the night queue and The Motion are not running.
# It holds results and settings, never secrets: Keychain items, the logins in
# ~/.claude, ~/.codex, ~/.gemini and the Ollama models (~/.ollama) stay out.
# It reads and copies; it deletes nothing.
set -e
cd "$HOME"
OUT="$HOME/studio-backup-$(date +%Y-%m-%d).tgz"
INFO=".agent-dispatch/laptop-info"
mkdir -p "$INFO"

# What was scheduled and installed here, to set up the same on the new laptop.
{ date; launchctl list | grep -i agents-wrapper || echo "(no launchd jobs)"; } > "$INFO/launchd.txt"
cp Library/LaunchAgents/com.agents-wrapper.*.plist "$INFO/" 2>/dev/null || true
crontab -l > "$INFO/crontab.txt" 2>/dev/null || echo "(no crontab)" > "$INFO/crontab.txt"
pmset -g sched > "$INFO/pmset.txt" 2>&1 || true
{ command -v ollama >/dev/null && ollama list; } > "$INFO/ollama.txt" 2>&1 || true
for t in node git gh claude agy codex ollama twg; do
  printf '%s\t%s\n' "$t" "$(command -v "$t" || echo missing)"
done > "$INFO/tools.txt"
: > "$INFO/unpushed.txt"
for r in agents-wrapper the-motion .agent-dispatch/trap-site .agent-dispatch/shapes-site; do
  [ -d "$r/.git" ] || continue
  echo "== $r"; git -C "$r" status -sb | head -20
  git -C "$r" log --branches --not --remotes --oneline | sed "s#^#$r: #" >> "$INFO/unpushed.txt"
done > "$INFO/git.txt" 2>&1

LIST=".agent-dispatch"
[ -d kofi ] && LIST="$LIST kofi"
for f in agents-wrapper/*.log; do [ -f "$f" ] && LIST="$LIST $f"; done

tar -czf "$OUT" --exclude node_modules --exclude .DS_Store $LIST
echo "Backup: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Check:  tar -tzf $OUT | head"
echo "Not pushed to GitHub (should be empty):"
cat "$INFO/unpushed.txt"; [ -s "$INFO/unpushed.txt" ] || echo "  nothing"
