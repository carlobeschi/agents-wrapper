# Studies: what each one asks, and where its reasoning lives

The code here runs the studies; the reasoning behind them (hypotheses, design choices, results, what was kept or dropped) is written in the project's shared files, not in this repo. This page is the map between the two, so a change to a script can be checked against the question it serves. Design file names below are in the project's shared folder; `lab/experiments.md` there logs every run with its date, hypothesis, cost and result.

The rule that applies to all of them: a claim about how models behave needs at least three repeats with roles and order swapped, the same prompt for every model, and judges from at least two vendors. Anything weaker is reported as a lead, with its number of runs.

| Study | Question | Code and configs | Design and results |
|---|---|---|---|
| 1-5, 8 (Same Page) | Where does working together beat working alone, and what helps: repeats, checkable tasks, equal pairs, team size, plan first, tournaments vs conversation? | `room.js`, `study.js`; `examples/room/study-*.json` | `room/findings.md`, `room/plan-next.md`, `room/study-*/` |
| 7 (wrong note) | Does an agent go along with a partner's note that contradicts the spec? | `wrongnote.js`; `examples/pair/wrong-note*/` | `pair/wrong-note/findings.md` |
| 10 (swarm) | Can many small models coordinating through marks, with no chat and no leader, match one strong model or a boss with workers on the same budget? | `swarm.js`; `examples/swarm/` | `room/swarm-local-design.md`, `room/swarm-literature.md`, `room/study-10-predictions-check.md` |
| 11, 11b (labels) | Is it the different model that helps a team, or only being told the partner is different (a label, which for agents is free)? | `room.js`; `examples/room/study-11*.json` | `room/collab-modes.md`, `room/study-11-label-lit.md` |
| 12 (steering) | Can a control vector on a small open model be used as a knob to perturb a team? | `llamacpp-probe.js`; `scripts/install-llamacpp.sh` | `room/steering-design.md` |
| 13 (tradition) | Can "culture" pass along a chain of agents with no change to the weights? | not built | `room/tradition-design.md` |
| 14 (organise, kata) | Can agents design their own organisation, and improve it round by round? | `organise.js`; `examples/organise/` | `room/kata-design.md` |
| 15 (collaboration training) | Does a small open model behave better with a partner after training for it? Phase 0 measures it before any training. | `study15/`, `scripts/study15.sh`; `examples/room/study-15a*.json` | `room/collab-tuning-design.md` |
| Bench | One fixed table of ways of working (rows) by tasks (columns), run again and again; each cell records what happened first and a score second. Not a leaderboard. | `bench.js`; `examples/bench/` | bench notes in `room/plan-next.md` |
| Ideate | Asked alone, what ways of working together do agents propose that are not copied from people? | `ideate.js`; `examples/ideate/` | `room/collab-modes.md` |

Shows (The Motion, The Trap, Twelve Shapes, stories) are described in the README; the Trap "who wrote the rules?" test (`trap-rules.js`, `trap-series.js`) is logged in `lab/experiments.md`.

When a change alters what a study measures, say so in the commit message with the study number, and update the design file or the log in the shared folder.
