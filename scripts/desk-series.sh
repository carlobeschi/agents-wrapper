#!/bin/zsh
# Repeats of the same round, group and solo in turn, then one table:
#   scripts/desk-series.sh <series name> [repeats] [example dir] [group workers]
#   DESK_MODEL=claude-haiku-5-5 scripts/desk-series.sh serie-1 3 examples/desk/jsonschema-mini-plain
# Runs <name>-gruppo-1, <name>-solo-1, <name>-gruppo-2, ... one after another
# with scripts/desk-round.sh, in $DESK_RUNS (default ~/claude-projects/desk).
# The table goes to <series name>-table.txt there too. A run that fails does
# not stop the series: its row says so.
cd "$(dirname "$0")/.."
NAME="$1"; R="${2:-3}"; FROM="${3:-examples/desk/jsonschema-mini-plain}"; G="${4:-3}"
[ -n "$NAME" ] || { echo "Usage: scripts/desk-series.sh <series name> [repeats] [example dir] [group workers]"; exit 1; }
RUNS="${DESK_RUNS:-$HOME/claude-projects/desk}"
mkdir -p "$RUNS"
for i in $(seq 1 "$R"); do
  for side in gruppo solo; do
    run="$NAME-$side-$i"
    if [ "$side" = gruppo ]; then n="$G"; else n=1; fi
    echo "=== $run ($n workers) ==="
    DESK_RUNS="$RUNS" scripts/desk-round.sh "$run" "$n" "$FROM" || echo "$run failed"
    for k in $(seq 1 20); do lsof -ti :8790 >/dev/null 2>&1 || break; sleep 1; done
  done
done
node desk.js table "$RUNS" "$NAME" | tee "$RUNS/$NAME-table.txt"
