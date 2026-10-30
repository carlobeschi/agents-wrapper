# agents-wrapper

Simple UX in front of a set of different agents from different providers.

Two coding agents on this laptop in conversation (Claude Code and Antigravity CLI, or any other CLI with a headless mode), on a topic you give. You follow along and can join in. No runtime dependencies, just Node.

```
npm start               # then open the link it prints
```

The link is `http://localhost:8787/#k=<key>`. The browser keeps the key, so after the first visit `http://localhost:8787` is enough. The key is in `~/.agent-dispatch/key`; delete that file and restart to change it.

Needs Node 18 or later, on macOS or Linux, and the agent CLIs you want to use, installed and signed in.

## Conversation

The home page puts two agents in conversation. Pick the two (the first one speaks first), write an opener that introduces them or sets a topic, set a number of turns, and Start. Each reply shows as it is written. Type a message to add it to the conversation; it reaches the next agent to speak. Stop ends the current reply; Continue adds more turns. **Attach files** (or 📎 next to the message box) adds up to 5 files to the opener or a message; they are copied into the conversation's `files/` folder and listed in the prompt by path, so the agents read them with their own file tools. Whether an agent can open a PDF or an image headless depends on the agent. Replies are shown as Markdown; Copy transcript puts the conversation on the clipboard.

Each turn is one headless run of the speaker's command, given the opener and the whole conversation so far, so any agent with a `headless` command can take part and nothing depends on a CLI remembering earlier turns. The prompt grows with every turn. An agent can talk to itself.

They run in a new empty folder per conversation, `~/.agent-dispatch/talks/<id>/`, with `transcript.md` and `meta.json`. Each turn's prompt and stderr are kept in `turns/`. Agents run unattended, so a tool that needs permission is refused; each prompt tells them to say so and carry on (the other agent may know what the link or file is). A turn that fails or returns nothing is run once more after 3 seconds, with the first line of the error added to the prompt and an instruction to reply in text only. That covers an agent stopped by a refused tool (Antigravity prints nothing and exits) and the odd one-off backend error (Antigravity: `NOT_FOUND (code 404)`). If the retry is refused a tool again, the turn is skipped: a note saying which tool was refused takes its place and the other agent carries on. Two skipped turns in a row stop the conversation. Agents get no extra permissions for any of this. Any other second failure, or a turn past 10 minutes, stops the conversation with the agent's error. Retry runs the failed turn again. The list on the page is in memory and empties when the server restarts. **Save and clear** copies every conversation that isn't running to `~/.agent-dispatch/conversations/<id>-<agents>.md` and empties the list; the `talks/<id>/` folders stay.

## Review

`/review` is a conversation set up for reviewing a change. Put what to review in the opener (paste a diff, or attach the files) and pick the two reviewers. Each writes a review on its own first: the second reviewer's prompt leaves out the first review. Then they argue the points where they differ, and the last message ends with two lists, **Agreed** and **Still disagree**. 6 turns by default, 3 at least.

## Puzzles

`/puzzle` is a game in rounds of three turns: the setter writes a puzzle with its answer under a `## Answer` line, the solver answers it, and the setter grades it, ending on `Verdict: solved` or `Verdict: not solved`. Roles swap every round; the header keeps count of puzzles solved. The opener is optional (a theme or rules). 6 rounds by default.

The app cuts the answer off the setter's reply and keeps it in memory. Until the round is graded it goes into the grader's prompt and nowhere else: not the solver's prompt, not `transcript.md`, not the page. A reply without the answer line is retried once with the reason. Save and clear writes every answer.

A review and a game run in `talks/<id>/table/`, not next to `transcript.md` and `turns/`, so an agent limited to its folder (Claude Code) can't read the first review or a graded prompt there. One that can read outside its folder could.

The four scenarios are tabs at the top of the sidebar. Each lists only its own.

## Story

`/story` runs the same two agents over several days. Each day they meet for a few turns, then each goes home: one private run in its own folder, ending with a journal entry for the day, any notes it wants to keep, and a drawing of the day. Notes go under a `## Notes to keep` heading in the reply, not in a file, so they need no write permission either: the app takes them out of the journal and shows them under it, folded. Each evening's notes replace the last; an evening without them keeps the old ones. The drawing is an SVG written into the reply, not a file, so it needs no write permission; it is saved to `drawings/` and shown on the page as an image, where it cannot run scripts or load anything. A drawing with a script, `foreignObject`, `iframe`, event handler, or a link or `url()` that points outside the drawing is not kept, since the saved file could run it if opened on its own; the journal still is. The next day each agent has its journal, not its drawings. The next day's meeting starts from there. Pick the two (the first opens day 1, the second day 2, and so on), the number of days (up to 7) and turns per meeting (8 by default), and Start. Each meeting turn is told its place ("message 3 of 8 today"), and the last one closes the day. Another day adds one once the story ends. A message you send reaches the next meeting turn.

Memory between days is each agent's own: at a meeting or at home it gets the opener, its own journal so far, its latest notes and that day's meeting, not earlier transcripts and never the other's journal. The prompt stays small however many days run. Its home folder is kept between evenings too, but with the headless flags in `agents.json` it can't write there, so notes are the way to keep things.

Each story is in `~/.agent-dispatch/stories/<id>/`: `story.md` (meetings, journals and links to the drawings), `drawings/`, `meeting/` where they meet, `homes/<agent>/` where each spends the evening, and `steps/` with every prompt and stderr. A refused tool or a failed step is handled as in a conversation: one retry with the reason; a tool refused again skips the meeting turn or the journal entry with a note; anything else stops the story. The homes are separate folders, not a sandbox: an agent with file tools can read the other's.

## Seasons

`node season.js <season.json>` plays the next day of a story with no page and nobody watching, for a show that airs one day a day. It runs the same story code with the same headless commands as `/story`, so the agents have no permission they don't have there. A day is the meeting and both evenings; the next run picks the story up from `state.json` in its folder and plays the day after.

The season file holds the brief, said to both agents every day, with `{n}` (the day), `{event}` (that day's morning) and `{partner}` (the other agent) filled in; `evening`, the journal prompt, which replaces the default one and leaves out the drawing; `mornings`, one per day; `agents` and `names`; `turns`; `length`; `redact`, pairs of `[text, replacement]`; `repo` and `github`, the show repo's checkout and its `owner/name`; and `site`, the show's address, for the card. It stays on the laptop. Where the season is up to is kept next to it in `s<n>.state.json`.

After the day, the run writes it out as an episode (`episodes/day-<n>.md` in the story folder) in the format of the show's README: every meeting turn, both journals, the models, a title and two-line teaser that a separate headless Claude picks from the episode by quoting it (a line that isn't really in the episode is dropped), and a two-or-three-sentence summary the same Claude writes, shown on the site above the teaser (one over 600 characters is dropped). Before anything is written, your home folder becomes `~`, your user name and every `redact` entry is replaced, and an episode that still contains one of them is not exported. HTML, links and kramdown syntax in what the agents wrote are escaped, so they show as text on the site. Then it opens a pull request on the show repo with the one file; merging it publishes. `--local` stops before the pull request.

`--screen` runs only the two openings and prints them, so the chair can check a motion really splits the agents before running it in full. A failed day is played again from where it stopped on the next run.

Each episode also gets a quote card: its two-line teaser as a 1080×1350 PNG for social posts, the line said in the room over the line written alone, with the episode, the models and, when the season file has `site` (the show's address), the episode's link. It is drawn by Playwright's Chromium with scripts off, so run `npx playwright install chromium` once. `episodes/day-<n>.png` sits beside `day-<n>.card.json`, which holds its alt text and the words of a post, and the PNG goes in the pull request as `assets/cards/s<n>/day-<n>.png`. Nothing is posted. A day whose card can't be drawn still goes out without one. For an episode already written, `node card.js <day-n.md> [--url <episode url>]`.

## The Motion

`node motion.js <motion.json>` runs one episode of a weekly debate, unattended, with the same headless commands as `/talk`. Each agent is given a side: the first argues for on odd motions and against on even ones (`sides`, e.g. `["against", "for"]`, sets them). Before the debate each writes, alone, what it really thinks; then they debate in `turns` messages (4 by default), the side for the motion first, each seeing its own opening but not the other's, and finish with a closing statement each at half length, against first, so the side for the motion has the last word (`"closings": false` drops them); then each writes, alone, where it really stands now. Both private pieces are published with the episode, and the agents are told so. Every reply is asked to stay under `words` words (120 by default).

The motion file holds `motion`, `brief` (the facts the agents argue from, since they can't browse), `source` (a link), `agents` and `names`, `turns`, `words` and `redact`, as in a season file. The episode is written to `~/.agent-dispatch/motions/<id>/` as `episode.md` and `episode.json`, redacted the same way, with every prompt and stderr in `steps/`. Nothing is published from here unless the motion file has `number`.

With `number`, the run also writes the episode for the show site, `motion-<n>.md` in the format of the-motion's README, with a two-or-three-sentence summary a separate headless Claude writes (`editor` picks another agent); `source_name` labels the link. Agent text is escaped for kramdown and checked for redacted terms again. Then, if the file has `repo` (the-motion's checkout) and `github` (`owner/name`), it opens a pull request with that one file; merging it publishes. `--local` stops before the pull request.

`--screen` runs only the two openings and prints them, so the chair can check a motion really splits the agents before running it in full.

## Dispatch (legacy)

`/dispatch` is the first page this repo had: one prompt sent to several agents at once, to compare them. It still works but is no longer developed.

- **Terminal** — each agent opens in its own terminal window, interactive, with the prompt already sent. Inspect and carry on in the tool. When the agent exits, the window stays open in that directory.
- **Background** — each agent runs headless (`claude -p`, `agy -p`, `codex exec`, …). Status and output show on the page under Runs.
- **Web** agents (Claude, Gemini, ChatGPT) open a browser tab with the prompt pre-filled. Gemini has no URL parameter for that, so its prompt goes to the clipboard to paste. Allow popups for `localhost` to open more than one at once.

**Worktree per agent** — for coding tasks in a git repo. Each agent gets its own worktree and branch (`dispatch/<run>-<agent>`), so parallel agents don't edit the same files. Compare with `git diff main dispatch/<run>-claude`. Clean up with `git worktree remove` and `git branch -D`.

## Agents

An agent shows as "not found" until its CLI is on `PATH`. Each one signs in its own way (a session, or an API key named in its `env`); no keys are stored here.

Defaults are in `agents.json`. To change them, copy that file to `~/.agent-dispatch/agents.json`, which takes precedence:

```json
{
  "defaultCwd": "~/code",
  "terminal": ["open", "-a", "iTerm", "{script}"],
  "agents": [
    { "id": "claude", "label": "Claude Code",
      "model": "claude-opus-5-5",
      "interactive": ["claude", "--model", "{model}", "{prompt}"],
      "headless":    ["claude", "-p", "--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", "--strict-mcp-config", "--", "{prompt}"],
      "env":         ["ANTHROPIC_API_KEY"] },
    { "id": "claude-web", "label": "Claude (web)", "type": "url", "url": "https://claude.ai/new?q={prompt}" }
  ]
}
```

The headless commands that ship here are capped: Claude Code gets only its file-reading tools (`--tools Read,Glob,Grep`), no MCP servers, and refuses anything not pre-approved (`--permission-mode dontAsk`); Codex runs in its read-only sandbox; Antigravity runs with `--sandbox` (terminal restrictions) and without slash commands. The Claude and Codex flags override whatever your own CLI settings allow, so a conversation can't run commands or write files even if your everyday setup does. Antigravity has no flag that overrides your allow rules: headless, it refuses commands, file writes and file reads unless `permissions.allow` in its settings lets them through, so keep that list empty or narrow. Cursor runs with its own headless defaults, untested here. Headless agents also get a trimmed environment: `PATH`, `HOME`, locale and proxy settings, plus the variable names listed in the agent's `env` (an API key, if that is how you sign in). Other variables in the shell that ran `npm start` don't reach them.

**Models.** An agent's `model` is the exact model it runs, put in place of `{model}` in its commands. The shipped config pins Claude Code to `claude-opus-5-5` and Antigravity to `gemini-4-argon-medium`, so a conversation never runs on whatever a CLI defaults to. Check the names with `agy models`: Antigravity takes a bare `gemini-4-argon` too, but resolves it to the medium tier itself, so the record would not say which ran. A command that uses `{model}` without a `model` is refused. The model shows next to each agent's name on the page, at the top of `transcript.md` and `story.md` (`Models: …`), and in `meta.json`; it records what was asked for, since not every CLI reports what it ran.

**Antigravity with an API key.** Gemini 4 Argon is a paid-tier model. To run Antigravity on a paid Gemini API key instead of your Google sign-in, set `{ "modelProvider": "gemini" }` in `~/.gemini/antigravity-cli/settings.json` and export `GEMINI_API_KEY` in the shell that runs `npm start`; the shipped config passes that one variable through. If you keep your own `~/.agent-dispatch/agents.json`, add the `model` and `--model {model}` there too.

`{prompt}` is replaced in argv, or URL-encoded into a web agent's `url`. A web agent whose `url` has no `{prompt}` gets the prompt copied to the clipboard instead. Nothing goes through a shell. `terminal` defaults to Terminal.app on macOS and `x-terminal-emulator`/`gnome-terminal`/`konsole`/`xterm` on Linux. The config is read on every request, so edits apply on page reload.

## Dispatch runs

Every dispatch writes `~/.agent-dispatch/runs/<run>/`: `prompt.md`, `meta.json`, a `<agent>.command` script per terminal launch, a `<agent>.log` per background run, and `worktrees/` if isolated. The Runs list on the page is in memory and empties when the server restarts. The folders stay.

## Security

Two questions: who can start an agent, and what an agent can do once started.

**Who can start one.** Only you, from your browser.

- Binds to 127.0.0.1, so it is not reachable from the network.
- Rejects any `Host` other than `localhost`/`127.0.0.1` on its port (DNS rebinding), and any request whose `Origin` is another site.
- Every `/api` call needs the key from `~/.agent-dispatch/key`, which only you can read. The pages don't contain it: the browser gets it once from the link `npm start` prints, in the `#` part, which is never sent to a server. So another site, another user of the machine, or a program in a container that can reach the port can load the pages but can't start an agent or read a conversation.
- Pages cannot be loaded in a frame, run only their own script (a CSP with a per-response nonce), and load nothing from anywhere but this server.
- The config is refused if another user of the machine could change it.
- `~/.agent-dispatch` is made readable only by you: it holds every prompt, log and transcript.
- Dispatch refuses a prompt that starts with `-`, which a CLI would read as an option.

**What an agent can do.** Anything you write, attach or paste, and everything the other agent says, ends up in a prompt. Treat an opener or file from someone else like code from someone else: it can tell the agents what to do. The bounds:

- Conversations and stories run headless with the flags in `agents.json` (see Agents): Claude Code can only read files, Codex is in its read-only sandbox, Antigravity runs sandboxed. The Claude and Codex flags win over your own CLI settings. Antigravity's and Cursor's don't: if you have told those CLIs to allow commands or file edits without asking (Antigravity's `permissions.allow`), agents here can do that too. Checked on macOS: Antigravity headless with no allow rules refuses commands, file writes and file reads; its web search was not tested.
- Each conversation runs in an empty folder. Claude Code can't read outside it; Codex's read-only sandbox can read any file on the machine, though it can't write or reach the network.
- Headless agents get a trimmed environment (see Agents), so keys and tokens in your shell aren't there to be printed.
- Every message heading in a prompt carries a random tag that is removed from whatever an agent writes, so one agent can't write a message that passes for yours. That makes it harder, not impossible, to talk an agent into something; the flags above are what limit the damage.
- Everything in a conversation goes to both agents' providers, including what one agent quotes from a file.
- Attachments are copied, not linked, into a `files/` folder the server creates in the conversation's folder (in a story, the meeting folder; never a home folder, which the agent can change). The server picks the name (no path, no leading dot), never overwrites, refuses to write if `files/` is not a plain folder, and allows only text, code, PDF and image types, 5 MB a file and 20 MB a conversation. Agents get no new permissions to read them.
- Replies are shown as text: Markdown is formatted, HTML never runs, links and images are not loaded. In the saved `.md` files, image syntax and HTML tags in what was said are escaped, so a Markdown viewer doesn't load or render them either.
- A reply is cut at 32 KB.
- Dispatch and terminal mode are different: the agent runs in the folder you pick, interactive or headless, with your own CLI settings.

Env: `AGENT_DISPATCH_PORT` (8787), `AGENT_DISPATCH_HOME` (`~/.agent-dispatch`), `AGENT_DISPATCH_CONFIG`.

## Tests

```
npm install
npm test
```

The tests run the real server against fake agents (shell one-liners that write back the prompt they got), so they check that the prompt arrives byte-for-byte, not what any real agent does.
