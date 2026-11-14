# Notes for coding agents

The README is the manual: what every script does, its config files and its outputs. This file covers how to work in this repo without breaking it. Read it before your first change.

## Commands

- `npm ci`: install. Use this, not `npm install`, so package-lock.json stays as it is.
- `npm run check`: everything CI runs: lint, type check, then the tests. Run it before you push.
- `npm run lint`: ESLint (`eslint.config.js`), real mistakes only (undefined names, unused variables), not style.
- `npm run typecheck`: TypeScript's checker on plain JS, only on files that start with `// @ts-check`. Files without it had type complaints that would need rewriting to fix; add the line to a file once it passes, never remove it to get green.
- `npm test`: the tests. It runs the Playwright suite in `tests/`, including the Python tests in `study15/test_core.py` (through `tests/study15.spec.js`). CI runs the same command on every pull request (`.github/workflows/test.yml`).
- `npx playwright test tests/<name>.spec.js`: one file. Browser tests need Chromium (`npx playwright install chromium`).
- `npm start`: the local app on port 8787 (README, top).
- `python3 -I study15/test_core.py`: only the study 15 Python tests.

The tests run the real code against fake agents (shell one-liners in the tests, `tests/fixtures/`). They never call a real model, so they are free and offline. Keep it that way.

## Layout

- Top-level `*.js`: one script per show or study, run as `node <script>.js <config.json>`. `server.js` plus `talk.html`, `story.html` and `dispatch.html` make the local app. `config.js` loads `agents.json` and runs agents. `publish.js` is the only path to GitHub.
- `agents.json`: default agents and their headless commands. A user copy in `~/.agent-dispatch/agents.json` overrides it.
- `examples/`: config files for shows and studies. `examples/night/queue.json` is the night queue, read by `night.js` every evening after a `git pull`, so a merged change to it takes effect that night.
- `scripts/`: shell wrappers and launchd plists for the Mac (night queue, The Motion daily, The Trap weekly, laptop setup).
- `study15/`: Python for study 15 (Modal, vLLM). Versions are pinned in `phase0_modal.py` on purpose; read the comment before changing them.
- `tests/`: one `<script>.spec.js` per script.
- Run outputs live in `~/.agent-dispatch/` on the Mac, never in the repo.

## Never

- Never loosen agent permissions: no `--dangerously-skip-permissions`, no bypass or full-access sandbox flags, no allow-rules, no extra tools in the headless commands in `agents.json`. `pair.js` refuses such flags and the tests check it. See README, Security.
- Never commit a real name, an email address, a home folder path (`/Users/...`) or a key. The repo is public. Commits made by the scripts go through `publish.js`, which redacts and commits as a noreply identity.
- Never ask for API keys or paste them anywhere. Keys live in the macOS Keychain and the scripts read them there.
- Never make a script publish, merge or post without a person, unless the README already says it does (The Motion daily merges its own episode; every other show opens a pull request for a person to review).
- Never call a real model from a test.
- Never force-push `main`. Its history was rewritten once (October 2026): fetch and rebase, and never push an old local copy.

## Before you push

- `npm run check` passes.
- A new script or config option is described in the README, in the same plain style.
- A new night job in `examples/night/queue.json` has `max_minutes` and a `claude_calls` estimate (the queue has a Claude call budget per night; see the comment at the top of `night.js`).
- `npx playwright test` deletes `test-results/`. Copy anything you want to keep out of it first.

## Where the reasoning lives

Study designs and the experiment log are kept outside this repo, in the project's shared files (`room/*-design.md`, `lab/experiments.md`). [docs/studies.md](docs/studies.md) maps each study to its question, its code and its design file. Commit messages name the study they serve ("study 15a"). If a change needs a design decision that isn't written down, ask rather than guess.
