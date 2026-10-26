# agents-wrapper

Simple UX in front of a set of different agents from different providers.

Two coding agents on this laptop in conversation (Claude Code and Antigravity CLI, or any other CLI with a headless mode), on a topic you give. You follow along and can join in. No runtime dependencies, just Node.

```
npm start               # then open http://localhost:8787
```

Needs Node 18 or later, on macOS or Linux, and the agent CLIs you want to use, installed and signed in.

## Conversation

The home page puts two agents in conversation. Pick the two (the first one speaks first), write an opener that introduces them or sets a topic, set a number of turns, and Start. Each reply shows as it is written. Type a message to add it to the conversation; it reaches the next agent to speak. Stop ends the current reply; Continue adds more turns. **Attach files** (or 📎 next to the message box) adds up to 5 files to the opener or a message; they are copied into the conversation's `files/` folder and listed in the prompt by path, so the agents read them with their own file tools. Whether an agent can open a PDF or an image headless depends on the agent. Replies are shown as Markdown; Copy transcript puts the conversation on the clipboard.

Each turn is one headless run of the speaker's command, given the opener and the whole conversation so far, so any agent with a `headless` command can take part and nothing depends on a CLI remembering earlier turns. The prompt grows with every turn. An agent can talk to itself.

They run in a new empty folder per conversation, `~/.agent-dispatch/talks/<id>/`, with `transcript.md` and `meta.json`. Each turn's prompt and stderr are kept in `turns/`. Agents run unattended, so a tool that needs permission is refused; each prompt tells them to say so and carry on (the other agent may know what the link or file is). A turn that fails or returns nothing is run once more after 3 seconds, with the first line of the error added to the prompt and an instruction to reply in text only. That covers an agent stopped by a refused tool (Antigravity prints nothing and exits) and the odd one-off backend error (Antigravity: `NOT_FOUND (code 404)`). A second failure, or a turn past 10 minutes, stops the conversation with the agent's error. Retry runs the failed turn again. The list on the page is in memory and empties when the server restarts. **Save and clear** copies every conversation that isn't running to `~/.agent-dispatch/conversations/<id>-<agents>.md` and empties the list; the `talks/<id>/` folders stay.

## Story

`/story` runs the same two agents over several days. Each day they meet for a few turns, then each goes home: one private run in its own folder, where it can think, write notes or make things, ending with a journal entry for the day. The next day's meeting starts from there. Pick the two (the first opens day 1, the second day 2, and so on), the number of days (up to 7) and turns per meeting, and Start. Another day adds one once the story ends. A message you send reaches the next meeting turn.

Memory between days is each agent's own: at a meeting or at home it gets the opener, its own journal so far and that day's meeting, not earlier transcripts and never the other's journal. The prompt stays small however many days run. What it left in its home folder is still there the next evening; whether it can write files there depends on the permissions its headless command runs with.

Each story is in `~/.agent-dispatch/stories/<id>/`: `story.md` (meetings and journals), `meeting/` where they meet, `homes/<agent>/` where each spends the evening, and `steps/` with every prompt and stderr. A refused tool or a failed step is handled as in a conversation: one retry with the reason, then the story stops. The homes are separate folders, not a sandbox: an agent with file tools can read the other's.

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
- Attachments are copied, not linked, into a `files/` folder the server creates in the conversation's folder (in a story, the meeting folder; never a home folder, which the agent can change). The server picks the name (no path, no leading dot), never overwrites, refuses to write if `files/` is not a plain folder, and allows only text, code, PDF and image types, 5 MB a file and 20 MB a conversation. Agents get no new permissions to read them.
- In a conversation each agent's reply is the other's prompt. The empty folder keeps your repos out of the working directory, not out of reach, so an agent that runs tools without asking can be talked into running them.

Env: `AGENT_DISPATCH_PORT` (8787), `AGENT_DISPATCH_HOME` (`~/.agent-dispatch`), `AGENT_DISPATCH_CONFIG`.

## Tests

```
npm install
npm test
```

The tests run the real server against fake agents (shell one-liners that write back the prompt they got), so they check that the prompt arrives byte-for-byte, not what any real agent does.
