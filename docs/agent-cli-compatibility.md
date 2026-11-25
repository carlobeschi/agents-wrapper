# Agent CLI compatibility

This is the compatibility record for the command-line agents in `agents.json`.
Web agents are URL integrations, not local CLIs, and are not covered here.
The shipped commands and safety-sensitive flags are checked without invoking
any agent in `tests/config.spec.js`.

## Supported commands

No semver range is promised or pinned. Compatibility claims are limited to the
exact versions listed below and to the command templates tested in this
repository. Re-check the CLI's help output and this matrix when upgrading a
CLI; model availability is not verified by a version or help check.

| CLI; version evidence | Headless invocation in `agents.json` | Prompt and working directory | Permission controls | Prerequisites and confidence |
| --- | --- | --- | --- | --- |
| Claude Code; `2.1.332`, local `claude --version`, 2026-11-25 | `claude -p --model {model} --tools Read,Glob,Grep --permission-mode dontAsk --strict-mcp-config -- {prompt}` | Prompt is one argv value after `--`; wrapper spawns with the run folder as `cwd`. | Read/Glob/Grep only, `dontAsk`, strict MCP config. | `claude` on `PATH`; sign in or provide `ANTHROPIC_API_KEY`; optional `CLAUDE_CONFIG_DIR`. **High** confidence in argv/version; permission behavior is configured and help-checked, not exercised against a real agent. |
| Antigravity CLI (`agy`); `1.5.16`, local `agy --version`, 2026-11-25 | `agy --model {model} --sandbox --settings '{"toolPermission":"request-review","allowNonWorkspaceAccess":false,"enableTerminalSandbox":true,"permissions":{"deny":["write_file(*)","command(*)","mcp(*)","read_url(*)","execute_url(*)","download_url(*)"]}}' --disable-slash-commands -p {prompt}` | Prompt is one argv value after `-p`; wrapper sets `cwd` to the run folder. | Settings request review, disallow non-workspace access, enable terminal sandbox, and deny file writes, commands, MCP and URL tools. | Install `agy`, complete first-run terminal setup/workspace trust, and sign in or configure a supported Google API credential. `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and `GOOGLE_CLOUD_PROJECT` are the allowlisted environment names. **High** confidence in argv/version; enforcement is not end-to-end tested. |
| Codex CLI; `0.172.0`, local `codex --version`, 2026-11-25 | `codex exec --sandbox read-only --skip-git-repo-check -` (default config); the example config additionally passes `-m {model}`. | Prompt is written to stdin; `-` tells `codex exec` to read it there. Wrapper sets `cwd` to the run folder. | `--sandbox read-only`. | Install `codex` and sign in or provide `OPENAI_API_KEY`; optional `CODEX_HOME`. **High** confidence in argv/version; the test does not make a model request. The configured sandbox is a CLI boundary, not OS isolation. |
| Cursor Agent; not installed in the verification environment | `cursor-agent --mode ask -p {prompt}` | Prompt is one argv value after `-p`; wrapper sets `cwd` to the run folder. | Ask mode; no force/yolo bypass flags. | Install `cursor-agent` and provide `CURSOR_API_KEY` or complete Cursor sign-in. **High** confidence in the configured/tested argv; **unverified** against a live binary or version here. |

`tests/config.spec.js` checks the shipped command templates, permission flags,
environment allowlists, and that prompts are passed as a single argument or
through stdin as configured. `config.js` performs placeholder substitution;
`talk.js` and `motion.js` spawn with `shell: false`, the run directory as
`cwd`, and a trimmed environment. These are command-construction checks, not
proof that a vendor honors each permission setting.

## Runtime contract

For conversations, a run is successful only when the process exits with code
zero and produces non-empty stdout. A failed or empty run is retried once;
conversation turns are stopped after 10 minutes, and Stop terminates the child
process tree. Motion steps use the same success signal and 10-minute default
(overridable by `AGENT_DISPATCH_STEP_TIMEOUT_MS`). Story editor calls use a
separate five-minute timeout. Stderr is retained for diagnosis; ANSI escapes
are removed before output is used.

## Sources and safe checks

- Repository configuration and construction: [`agents.json`](../agents.json),
  [`examples/setup/agents.shows.json`](../examples/setup/agents.shows.json),
  [`config.js`](../config.js), [`talk.js`](../talk.js),
  [`motion.js`](../motion.js), and [`tests/config.spec.js`](../tests/config.spec.js).
- Upstream references: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference),
  [Antigravity getting started / CLI](https://antigravity.google/docs/getting-started?tab=cli),
  [Codex CLI](https://developers.openai.com/codex/cli), and
  [Cursor documentation](https://cursor.com/docs).
- Run `npm run check:agent-clis` to optionally check installed binaries with
  only `--version` and `--help`. It does not pass credential environment
  variables or prompts and never makes a model call. Missing binaries are
  reported as skipped. CI uses only the configuration tests and does not
  require any CLI installation or personal credentials.

The local version observations above are evidence for those exact installed
builds, not a support-range guarantee. Cursor could not be version-checked in
that environment, and Cursor's currently linked documentation did not expose a
CLI flag reference. No real model call or end-to-end permission test has been
performed for any CLI.

## Mistral Vibe observed locally (not integrated)

The local executable is `vibe`, identified by its help output as **Mistral
Vibe**, version `3.1.5` (`env -i PATH="$PATH" vibe --version`, 2026-11-25).
Its credential-free `--help` advertises a headless `--prompt` / `-p` option,
`--model`, `--workdir`, and `--time-limit`; it also exposes approval-policy
and tool allow/deny options. The upstream project identifies Vibe as Mistral's
CLI coding agent: [mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe).

Vibe is **not configured in `agents.json` or
`examples/setup/agents.shows.json`**, so there is no supported
agents-wrapper invocation or command-construction test for it. Although its
help lists headless operation, we have not established a safe, least-privilege
configuration for the wrapper, tested whether required approval behavior works
non-interactively, or verified prompt/output/exit handling. Treat it as
unverified and unsupported here until that work is done. Only version/help
were run, in an environment stripped to `PATH`; no API key, prompt, or model
call was provided.
