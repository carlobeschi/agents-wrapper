#!/bin/zsh
# One round on the desk: starts desk.js, N workers (desk-worker.js), waits for
# them, prints the report and stops the desk. Watch it live on the printed page.
#   scripts/desk-round.sh <new run dir> <workers> [example dir] [port]
#   scripts/desk-round.sh ~/.agent-dispatch/desk/group-1 3
#   scripts/desk-round.sh ~/.agent-dispatch/desk/solo-1 1
#   DESK_MODEL=claude-haiku-5-5 scripts/desk-round.sh ... (a cheaper model)
# Claude Code runs on the Keychain key "anthropic-key" if there is one,
# otherwise on the machine's Claude Code sign-in.
set -e
cd "$(dirname "$0")/.."
RUN="$1"; N="${2:-3}"; FROM="${3:-examples/desk/round1}"; PORT="${4:-8790}"
[ -n "$RUN" ] || { echo "Usage: scripts/desk-round.sh <new run dir> <workers> [example dir] [port]"; exit 1; }
if lsof -ti ":$PORT" >/dev/null 2>&1; then echo "Port $PORT is busy (an old desk?). Stop it: lsof -ti :$PORT | xargs kill"; exit 1; fi
echo "Code: $(git log -1 --format='%h %s')"
K=$(security find-generic-password -s anthropic-key -w 2>/dev/null) && export ANTHROPIC_API_KEY="$K"
if [ -f "$RUN/desk.json" ]; then echo "Continuing the run already in $RUN (delete the folder for a fresh one)"
else node desk.js init "$RUN" --from "$FROM"; fi
node desk.js serve "$RUN" --port "$PORT" &
DESK_PID=$!
trap 'kill $DESK_PID 2>/dev/null' EXIT
sleep 1
echo "Board: http://127.0.0.1:$PORT"
PIDS=()
for i in $(seq 1 "$N"); do
  node desk-worker.js "$RUN" --name "w$i" --desk "http://127.0.0.1:$PORT" --model "${DESK_MODEL:-claude-opus-5-5}" &
  PIDS+=($!)
  sleep 5
done
wait "${PIDS[@]}"
node desk.js report "$RUN" | tee "$RUN/report.txt"
