#!/bin/sh
# "Who wrote the rules?" (The Trap): Gemini words the rules once, then each
# rulebook plays 3 episodes (trap-series.js). Made for the night queue: the
# series folder is fixed, so a run stopped at 07:15 picks up where it left off
# the next night, and the Gemini rules are written only once. The outcome goes
# to the private reports clone (rules-author/latest.md) via trap-report.js.
#   sh ~/agents-wrapper/scripts/rules-author.sh
# The night queue (scripts/night.sh) has already read the Gemini key; run by
# hand, export GEMINI_API_KEY first.
cd "$(dirname "$0")/.." || exit 1
RULES="$HOME/.agent-dispatch/trap-configs/gemini-rules.json"
SERIES="$HOME/.agent-dispatch/trap-series/rules-author"
mkdir -p "$(dirname "$RULES")" "$SERIES"
LOG="$SERIES/night-$(date +%Y-%m-%d-%H%M%S).log"
{
  STATUS=0
  if [ ! -s "$RULES" ]; then
    node trap-rules.js antigravity "$RULES" || STATUS=$?
  fi
  [ "$STATUS" = 0 ] && { node trap-series.js examples/trap/rules-author.json --resume "$SERIES" || STATUS=$?; }
  echo "$STATUS" > "$LOG.status"
} 2>&1 | tee "$LOG"
STATUS=$(cat "$LOG.status" 2>/dev/null || echo 1)
node trap-report.js --log "$LOG" --status "$STATUS" --series "$SERIES" --rules "$RULES"
exit "$STATUS"
