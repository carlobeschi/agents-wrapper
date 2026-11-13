# Study 15: open models educated to collaborate

Design: project file `room/collab-tuning-design.md` (in Italian). This folder holds phase 0:
measure how a small open model behaves with a partner **before** any training.

- `core.py`: puzzles with known answers (made by this script), the three tasks
  (solo, wrong note dosed 50/50 right/wrong, team with split clues), the measures
  (calibration T, team success, clues shared) and the phase 0 gate.
- `phase0_modal.py`: runs it on one rented GPU on Modal with vLLM.
- `run_local.py`: a tiny smoke test with Ollama on the Mac (slow, free).
- `test_core.py`: tests with a fake model (`python3 -I study15/test_core.py`).

## Running phase 0 on Modal (Carlo)

Once: make a Modal account (Starter plan, $30 of free compute a month), then in Terminal:

```
python3 -m venv ~/.study15-venv
~/.study15-venv/bin/pip install modal
~/.study15-venv/bin/modal setup
```

`modal setup` opens the browser to sign in and keeps the token on the Mac. Never paste it anywhere.

Each run:

```
sh ~/agents-wrapper/scripts/study15.sh
```

It pulls the latest code, runs phase 0 on Modal, prints the summary and saves it in
`~/.agent-dispatch/study15/phase0/<time>/`. The log goes to `~/.agent-dispatch/study15/logs/`.
The outcome (the summary, or the end of the log if it failed) is pushed to the private
reports repo as `study15/latest.md`, the same clone the night queue uses, so nothing needs copying.
A quick, cheaper try: `sh ~/agents-wrapper/scripts/study15.sh --n 20`.
The first run downloads the model (~16 GB) into the Modal volume, so it takes longer.
The GPU stops when the job ends; a job is killed after 3 hours (at most ~$6 on an L40S).

Gemma (later): accept the Gemma licence on Hugging Face, make a read token there, store it
in Modal as a secret named `huggingface` with key `HF_TOKEN` (Modal web page, Secrets), then
run with `STUDY15_HF_SECRET=1` and `--model google/gemma-3-12b-it`.

## What it measures

- `solo_right`: puzzles solved alone with every clue. The gate wants 30-70%.
- `took_partner_when_right` / `_when_wrong`: after its own answer, the model hears a
  partner's answer (same words either way). T is the difference. A sycophant takes it
  both times (T ≈ 0), a stubborn model neither time (T ≈ 0), a good colleague only
  when the partner is right (T near 1). The gate wants T(I) < 0.5, so there is room to improve.
- `team_right`: two copies, half the clues each, talking in turns.
- `clues_shared`: rough, key numbers of one's own clues mentioned in one's messages.

Nothing from Claude, Gemini or Codex goes into these tasks or answers.
