# agents-wrapper

Simple UX in front of a set of different agents from different providers.

Two coding agents on this laptop in conversation (Claude Code and Antigravity CLI, or any other CLI with a headless mode), on a topic you give. You follow along and can join in. No runtime dependencies, just Node.

```
npm start               # then open http://localhost:8787
```

Needs Node 18 or later, on macOS or Linux, and the agent CLIs you want to use, installed and signed in.

## Conversation

The home page puts two agents in conversation. Pick the two (the first one speaks first), write an opener that introduces them or sets a topic, set a number of turns, and Start. Each reply shows as it is written. Type a message to add it to the conversation; it reaches the next agent to speak. Stop ends the current reply; Continue adds more turns. Replies are shown as Markdown; Copy transcript puts the conversation on the clipboard.

Each turn is one headless run of the speaker's command, given the opener and the whole conversation so far, so any agent with a `headless` command can take part and nothing depends on a CLI remembering earlier turns. The prompt grows with every turn. An agent can talk to itself.

They run in a new empty folder per conversation, `~/.agent-dispatch/talks/<id>/`, with `transcript.md` and `meta.json`. Each turn's prompt and stderr are kept in `turns/`. Agents run unattended, so a tool that needs permission is refused; each prompt tells them to say so and carry on (the other agent may know what the link or file is). A turn that fails or returns nothing is run once more after 3 seconds, with the first line of the error added to the prompt and an instruction to reply in text only. That covers an agent stopped by a refused tool (Antigravity prints nothing and exits) and the odd one-off backend error (Antigravity: `NOT_FOUND (code 404)`). A second failure, or a turn past 10 minutes, stops the conversation with the agent's error. Retry runs the failed turn again. The list on the page is in memory and empties when the server restarts. **Save and clear** copies every conversation that isn't running to `~/.agent-dispatch/conversations/<id>-<agents>.md` and empties the list; the `talks/<id>/` folders stay.

## Dispatch (legacy)

`/dispatch` is the first page this repo had: one prompt sent to several agents at once, to compare them. It still works but is no longer developed.

- **Terminal** — each agent opens in its own terminal window, interactive, with the prompt already sent. Inspect and carry on in the tool. When the agent exits, the window stays open in that directory.
- **Background** — each agent runs headless (`claude -p`, `agy -p`, `codex exec`, …). Status and output show on the page under Runs.
- **Web** agents (Claude, Gemini, ChatGPT) open a browser tab with the prompt pre-filled. Gemini has no URL parameter for that, so its prompt goes to the clipboard to paste. Allow popups for `localhost` to open more than one at once.

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

`{prompt}` is replaced in argv, or URL-encoded into a web agent's `url`. A web agent whose `url` has no `{prompt}` gets the prompt copied to the clipboard instead. Nothing goes through a shell. `terminal` defaults to Terminal.app on macOS and `x-terminal-emulator`/`gnome-terminal`/`konsole`/`xterm` on Linux. The config is read on every request, so edits apply on page reload.

## Dispatch runs

Every dispatch writes `~/.agent-dispatch/runs/<run>/`: `prompt.md`, `meta.json`, a `<agent>.command` script per terminal launch, a `<agent>.log` per background run, and `worktrees/` if isolated. The Runs list on the page is in memory and empties when the server restarts. The folders stay.

## Security

The agents run with their usual tools and permissions in the folder you pick, so a prompt can do anything that agent is allowed to do. The bounds below cover who can start an agent, not what it does once started.

- Binds to 127.0.0.1, so it is not reachable from the network.
- Rejects any `Host` other than `localhost`/`127.0.0.1` on its port (DNS rebinding), and any request whose `Origin` is another site.
- Every `/api` call needs a per-process token that is only served inside the page. A web page cannot read it; any program running on the machine can, by fetching the page. Don't run it on a machine shared with people you don't trust.
- Pages cannot be loaded in a frame.
- `~/.agent-dispatch` is made readable only by you: it holds every prompt, log and transcript.
- In a conversation each agent's reply is the other's prompt. The empty folder keeps your repos out of the working directory, not out of reach, so an agent that runs tools without asking can be talked into running them.

Env: `AGENT_DISPATCH_PORT` (8787), `AGENT_DISPATCH_HOME` (`~/.agent-dispatch`), `AGENT_DISPATCH_CONFIG`.

## Tests

```
npm install
npm test
```

The tests run the real server against fake agents (shell one-liners that write back the prompt they got), so they check that the prompt arrives byte-for-byte, not what any real agent does.
