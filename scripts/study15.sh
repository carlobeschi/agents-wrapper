#!/bin/sh
# Study 15 phase 0 on Modal, with a log, and the outcome sent to the private
# reports repo (study15/latest.md) so the cloud threads can read it.
#   sh ~/agents-wrapper/scripts/study15.sh              (Qwen3-8B, 200 puzzles)
#   sh ~/agents-wrapper/scripts/study15.sh --n 20       (a quick, cheaper try)
cd "$(dirname "$0")/.." || exit 1
[ -n "$STUDY15_NO_PULL" ] || git pull --quiet || echo "git pull failed: running the code already here"
MODAL="$HOME/.study15-venv/bin/modal"
[ -x "$MODAL" ] || { echo "Modal is not installed: see study15/README.md"; exit 1; }
LOGS="$HOME/.agent-dispatch/study15/logs"
mkdir -p "$LOGS"
LOG="$LOGS/$(date +%Y-%m-%d-%H%M%S).log"
BEFORE=$(ls -1d "$HOME"/.agent-dispatch/study15/phase0/*/ 2>/dev/null | tail -1)
{ "$MODAL" run study15/phase0_modal.py "$@"; echo $? > "$LOG.status"; } 2>&1 | tee "$LOG"
STATUS=$(cat "$LOG.status" 2>/dev/null || echo 1)
AFTER=$(ls -1d "$HOME"/.agent-dispatch/study15/phase0/*/ 2>/dev/null | tail -1)
SUMMARY=""
[ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ] && SUMMARY="${AFTER}summary.md"
if [ -n "$SUMMARY" ]; then
  node study15/report.js --log "$LOG" --status "$STATUS" --summary "$SUMMARY"
else
  node study15/report.js --log "$LOG" --status "$STATUS"
fi
echo "Log: $LOG"
exit "$STATUS"
