# agents-wrapper

Simple UX in front of a set of different agents from different providers.

One prompt box for the coding agents on this laptop. Pick one agent, or several to compare them on the same task, and send. No runtime dependencies, just Node.

```
npm start               # then open http://localhost:8787
```

## Modes

- **Terminal** — each agent opens in its own terminal window, interactive, with the prompt already sent. Inspect and carry on in the tool. When the agent exits, the window stays open in that directory.
- **Background** — each agent runs headless (`claude -p`, `gemini -p`, `codex exec`, …). Status and output show on the page under Runs.
- **Web** agents (Claude, ChatGPT) open a browser tab with the prompt pre-filled. Allow popups for `localhost` to open more than one at once.

**Worktree per agent** — for coding tasks in a git repo. Each agent gets its own worktree and branch (`dispatch/<run>-<agent>`), so parallel agents don't edit the same files. Compare with `git diff main dispatch/<run>-claude`. Clean up with `git worktree remove` and `git branch -D`.

## Agents

An agent shows as "not found" until its CLI is on `PATH`. Each one uses its own signed-in session, so there are no keys here.

Defaults are in `agents.json`. To change them, copy that file to `~/.agent-dispatch/agents.json`, which takes precedence:

```json
{
  "defaultCwd": "~/code",
  "terminal": ["open", "-a", "iTerm", "{script}"],
  "agents": [
    { "id": "claude", "label": "Claude Code",
      "interactive": ["claude", "--model", "opus", "{prompt}"],
      "headless":    ["claude", "-p", "{prompt}"] },
    { "id": "claude-web", "label": "Claude (web)", "type": "url", "url": "https://claude.ai/new?q={prompt}" }
  ]
}
```

`{prompt}` is replaced in argv. Nothing goes through a shell. `terminal` defaults to Terminal.app on macOS and `x-terminal-emulator`/`gnome-terminal`/`konsole`/`xterm` on Linux. The config is read on every request, so edits apply on page reload.

## Runs

Every dispatch writes `~/.agent-dispatch/runs/<run>/`: `prompt.md`, `meta.json`, a `<agent>.command` script per terminal launch, a `<agent>.log` per background run, and `worktrees/` if isolated. The Runs list on the page is in memory and empties when the server restarts. The folders stay.

## Security

Binds to 127.0.0.1. Rejects any `Host` other than `localhost`/`127.0.0.1` on its port (DNS rebinding). Every `/api` call needs a per-process token that is only served inside the page. Agents run with their usual tools and permissions in the directory you pick, so the bounds cover who can trigger a dispatch, not what an agent does once started.

Env: `AGENT_DISPATCH_PORT` (8787), `AGENT_DISPATCH_HOME` (`~/.agent-dispatch`), `AGENT_DISPATCH_CONFIG`.

## Tests

```
npm install
npm test
```

The tests run the real server against fake agents (shell one-liners that write back the prompt they got), so they check that the prompt arrives byte-for-byte, not what any real agent does.
