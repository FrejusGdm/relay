# relay: provider control surfaces

Researched on 2026-10-07.

This report describes exactly how relay can control each coding agent through the interfaces its maker officially offers. It is meant to decide the adapter design. It covers Claude Code, Codex, Cursor's command-line agent, T3 Code and OpenCode. For each one it answers seven questions:

1. How to start, message, stream, interrupt and resume a session.
2. How the agent reads project instructions, and how relay can hand it the job.
3. Which hooks or events let relay notice that a session stopped, including sessions relay did not start.
4. How to read usage and limit signals.
5. How to run several accounts of the same provider on one computer, and what the terms say about it.
6. How to run the agent unattended.
7. For T3 Code only: what it is, and whether the founder notes' claim about switching providers inside a thread is true.

At the end you will find a capability table, a proposed adapter interface, the first two adapters to build, and the decisions only the founder can make.

## How this was checked

Five research agents worked in parallel, one per tool. Each read the current official documentation, the public source code where it exists, and the changelogs and release pages. I then checked their main claims against the tools installed on this Mac by running only read-only help and status commands:

- Claude Code 2.1.282 (the newest changelog entry is 2.1.292).
- Codex CLI 0.160.0 (the newest stable release is 0.160.1, from 2026-10-05).
- Cursor agent 2026.09.18.
- OpenCode 1.18.30 (the newest release is 1.18.35, from 2026-10-06).
- The T3 Code desktop app 0.0.40 (the newest stable release is 0.0.45; the nightly build is 0.0.46).

No agent session was started, no usage was spent, and nobody's session transcripts or credential files were read. Only directory and file names, and in two cases database table names, were listed to describe storage layouts.

Three warnings about sources:

- **Codex's documentation moved.** Every `developers.openai.com/codex/...` page now redirects to `learn.chatgpt.com/docs/...`. Links below use the new addresses.
- **Summaries can be wrong.** The web-fetch tool returns a summary written by a smaller model. In one case, the shape of Claude's rate-limit event, it invented fields. Every schema quoted below was taken from the raw page text or from the source code, not from a summary.
- **Some quotes come from summaries.** A few quotes from Cursor's pages and forum came through that summarizer. They are marked, and should be checked by eye before anyone relies on them in public.

## Terms used in this report

- **Non-interactive mode (headless mode):** running an agent from a script with a prompt. It works without a person typing, and it exits when done.
- **Stream JSON / JSONL / NDJSON:** output where each line is one JSON object describing one event, such as "the session started" or "a tool ran". These names all mean the same thing: one JSON object per line.
- **JSON-RPC:** a simple protocol where each message is a JSON object that either calls a named method or answers one. Codex's app server uses it.
- **Server-sent events (SSE):** an HTTP response that stays open and delivers events as they happen. OpenCode's server uses it.
- **Hook:** a command the agent itself runs when something happens, such as a session starting or a turn stopping. Hooks are configured in the agent's settings files. Because the agent runs them, a hook fires even in a session relay did not start.
- **MCP (Model Context Protocol):** a standard way to give an agent extra tools served by another program.
- **ACP (Agent Client Protocol):** a standard way for an editor or other client to drive a coding agent over standard input and output.
- **Config directory:** the folder where an agent keeps its settings, login and session history. Pointing one process at a different config directory is how two accounts can coexist.
- **Turn:** one round in which the agent receives a message and works until it replies.

---

## 1. Claude Code

Main sources: the CLI reference (https://code.claude.com/docs/en/cli-reference), non-interactive mode (https://code.claude.com/docs/en/headless), sessions (https://code.claude.com/docs/en/sessions), hooks (https://code.claude.com/docs/en/hooks), the Agent SDK TypeScript reference (https://code.claude.com/docs/en/agent-sdk/typescript) and the changelog (https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).

### 1.1 Start, message, stream, interrupt, resume

**Starting a session.**

- An interactive session starts with `claude` or `claude "first prompt"`.
- A non-interactive session starts with `claude -p "prompt"`; the long form of `-p` is `--print`.
- In non-interactive mode Claude Code also reads the prompt from standard input, up to 10 MB.

**Sending messages to a running session.** Start it with `--input-format stream-json`, which only works together with `-p`. relay then writes one JSON line per user message to standard input:

```
{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null}
```

The errors page warns: "Each stream-json message must be a single newline-terminated JSON line" (https://code.claude.com/docs/en/errors).

**Streaming output.**

- `--output-format` accepts `text` (the default), `json` (one final result) or `stream-json` (one event per line, in real time).
- `--include-partial-messages` adds text as it is generated.
- `--include-hook-events` adds the hooks' own lifecycle events to the stream.
- The docs never state that `--verbose` is required, but every stream-json example uses it. The installed 2.1.282 binary contains the error text `Error: When using --print, --output-format=stream-json requires --verbose`. relay should always pass `--verbose` with stream-json.

**The events in the stream** (from the Agent SDK TypeScript reference, which documents the same messages):

- **`system` with subtype `init`.** It carries `session_id`, `cwd`, `model`, `permissionMode`, `tools`, `mcp_servers`, `apiKeySource`, `claude_code_version` and a `capabilities` list. It is normally the first event. Only the output of startup hooks can come before it.
- **`assistant`.** It carries the model's message and an optional `error` field. Possible values are `rate_limit`, `overloaded`, `authentication_failed`, `billing_error`, `server_error`, `max_output_tokens` and a few others. The docs explain the difference between two of them: "'overloaded': the API returned a 529 ... as opposed to 'rate_limit', which is a 429 against your quota".
- **`user`.** Tool results come back in this event.
- **`system` with subtype `api_retry`.** It carries `attempt`, `max_retries`, `retry_delay_ms`, `error_status` and `error`, where `error` can again be `rate_limit`.
- **`result`.** This is the last line. Its `subtype` is `success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd` or `error_max_structured_output_retries`. Its fields include `session_id`, `is_error`, `num_turns`, `duration_ms`, `total_cost_usd`, `usage`, `permission_denials` and `terminal_reason`. The docs call `total_cost_usd` "an estimate, not a billing statement".
- **`rate_limit_event`.** See section 1.4.

**Exit codes.** The headless page says: "Claude Code exits with code 0 on success and a non-zero code when the run fails". When the failure happens inside the run, the failure is printed as the result on standard output. The docs give no exit code that is specific to a usage limit.

**Interrupting a session.** The headless page has a section titled "Stop a run with SIGTERM":

- A SIGTERM makes Claude Code exit with code 143 and "records no result" for the unfinished turn.
- "To end the turn instead, send SIGINT, or call the Agent SDK's `interrupt()`".
- The SDK's `interrupt()` "Only available in streaming input mode".

The CLI's own protocol for sending an interrupt over standard input is used by the SDK but is not documented on its own. So relay should either use the SDK or send SIGINT.

**Resuming a session** (https://code.claude.com/docs/en/sessions):

- `--resume <id or name>` and `--continue` (the latter picks the most recent session in this folder).
- `--session-id <uuid>`, which lets relay choose the ID in advance.
- `--fork-session`, which resumes into a new ID.
- `--no-session-persistence`, which saves nothing.

Two cautions:

- A resume does not bring back `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model` or `--add-dir`, so relay must pass them again.
- The sessions page warns: "If you resume the same session in two terminals without forking, messages from both interleave into one transcript."

**Where sessions are stored.** The sessions page says: "`~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is your working directory path with non-alphanumeric characters replaced by `-`." The format is JSONL, but: "The entry format is internal to Claude Code and changes between versions." relay should not parse these files. The TypeScript SDK offers supported readers instead: `listSessions()`, `getSessionMessages()` and `getSessionInfo()`. Transcripts are deleted after 30 days by default (`cleanupPeriodDays`).

**The Agent SDK** (`@anthropic-ai/claude-agent-sdk` for TypeScript, and a Python package). `query({prompt, options})` starts the bundled `claude` program and reads the same events.

Options that matter for relay:

- `resume`, `forkSession`, `sessionId`
- `permissionMode`
- `systemPrompt`: either a string or `{type:"preset", preset:"claude_code", append}`. Without this option the SDK uses a minimal prompt, not Claude Code's own.
- `settingSources`
- `hooks`, `abortController`, `maxTurns`, `maxBudgetUsd`, `cwd`
- `env`, which replaces the environment rather than adding to it
- `pathToClaudeCodeExecutable`

The returned object also has methods `interrupt()`, `setPermissionMode()`, `setModel()` and `accountInfo()`. T3 Code drives Claude this way.

### 1.2 Project instructions and injecting a handoff

**Where Claude Code reads instructions** (https://code.claude.com/docs/en/memory):

- It reads `CLAUDE.md` files at several levels: managed by an organization, the user's (`~/.claude/CLAUDE.md`), the project's (`./CLAUDE.md` or `./.claude/CLAUDE.md`) and local (`./CLAUDE.local.md`).
- Files in the working folder and every folder above it load at launch. Files in subfolders load when Claude touches files there.
- "All discovered files are concatenated into context rather than overriding each other."
- A line such as `@path/to/file` imports another file, up to four levels deep.
- `.claude/rules/*.md` files also exist. Rules without a `paths:` header load at launch.

**AGENTS.md is now read, but only as a fallback.** Version 2.1.277 added this changelog entry: "in a project with no CLAUDE.md, Claude Code reads AGENTS.md instead". A `CLAUDE.local.md` also counts as a CLAUDE.md and blocks the fallback. So in a project that has both files, Claude ignores AGENTS.md unless the user changes the "Project instructions" setting. The setting is stored under `pluginConfigs` → `cc-plugin-agents-md@builtin` → `options.instructionFiles`, with the value `claude-md-and-agents-md`. The portable approach that works on every version is to put a line `@AGENTS.md` in CLAUDE.md.

**How relay can inject a handoff:**

- **The first prompt.** The simplest way: tell the agent to read `.relay/task.md` and `.relay/checkpoint.md`.
- **System prompt flags.** `--append-system-prompt "<text>"` or `--append-system-prompt-file <path>`, and `--system-prompt` or `--system-prompt-file`, which replace the default. The CLI reference says "All five work in both interactive and non-interactive modes." Using a flag together with its file form needs version 2.1.283 or later, which is newer than the installed 2.1.282.
- **A SessionStart hook.** It can return `hookSpecificOutput.additionalContext`; plain text printed by this hook also reaches Claude. The hooks page advises: "Write the text as factual statements rather than imperative system instructions", because instruction-like text "can trigger Claude's prompt-injection defenses".
- **A UserPromptSubmit hook.** It can add context to each prompt.
- **`--add-dir`.** It only grants file access. CLAUDE.md files in those extra folders load only when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set.

### 1.3 Hooks relay can use

**The full list of hook events** (https://code.claude.com/docs/en/hooks): SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd.

**Every hook receives** `session_id`, `transcript_path`, `cwd`, `permission_mode` and `hook_event_name` as JSON on standard input.

**The events most useful to relay:**

- **Stop.** It runs when a turn ends normally. Its input includes `last_assistant_message`. The docs say it "Does not run if the stoppage occurred due to a user interrupt. API errors fire StopFailure instead."
- **StopFailure.** This is the hook that signals limits. It "Runs instead of Stop when the turn ends due to an API error". Its input has `error`, `error_details` and `last_assistant_message`. `error` takes the values `rate_limit`, `overloaded`, `authentication_failed`, `billing_error`, `server_error` and others. The docs' example is `"error":"rate_limit","error_details":"429 Too Many Requests"`. It was added in version 2.1.78.
- **Notification.** Its `notification_type` can be `permission_prompt`, `idle_prompt`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_fired`, `quota_auto_resume_stale` or `quota_auto_resume_disabled`. The last three come from the automatic wait at a usage limit, described in section 1.4.
- **SessionStart.** Its `source` is `startup`, `resume`, `clear`, `compact` or `fork`.
- **SessionEnd.** Its `reason` is `clear`, `resume`, `logout`, `prompt_input_exit` or `other`. Its default time limit is only 1.5 seconds, so a relay hook must return quickly.
- **PreCompact and PostCompact.** Their trigger is `manual` or `auto`. They are useful for writing a checkpoint before context is compressed.

No hook fires when a user is merely approaching a limit.

**Noticing sessions relay did not start.** Hooks placed in the user settings file `~/.claude/settings.json` apply to "All your projects". The desktop app "reads the same settings files as the CLI", so the same hooks should fire for local sessions in the desktop app's Code tab. I infer this from the shared-settings statement; no page says it about hooks specifically. There are exceptions:

- Cloud sessions do not read local settings.
- Sessions started with `--bare` or `--setting-sources` without `user`, and organizations that set `allowManagedHooksOnly`, skip these hooks.
- Each config directory (see section 1.5) has its own settings file, so relay must install its hooks into every account's directory.

**Polling instead of hooks.** `claude agents --json --all` is described by the agent-view page as "the supported way to read session state from outside Claude Code" (https://code.claude.com/docs/en/agent-view). It lists background sessions and live interactive ones. Each entry has `state` (`working`, `blocked`, `done`, `failed` or `stopped`), `status` (`busy`, `waiting` or `idle`), `waitingFor`, `sessionId` and `pid`. The same page says the files in `~/.claude/jobs/` "are not a stable interface".

### 1.4 Usage and limit signals

**Commands** (https://code.claude.com/docs/en/commands):

- `/usage` shows "session cost, plan usage limits, and activity stats". `/cost` and `/stats` are aliases.
- `/status` shows the account and connection.
- In `-p` mode, sending `/usage` as the prompt returns its text as an assistant message.

**Current limit messages,** quoted exactly from https://code.claude.com/docs/en/errors:

- `You've hit your session limit · resets 3:45pm`
- `You've hit your weekly limit · resets Mon 12:00am`
- `You've hit your Opus limit · resets 3:45pm` (and the same for Sonnet)
- The warning `You've used 85% of your session limit · resets 3:45pm`
- A temporary limit on Anthropic's side that is not the user's quota: `API Error: Server is temporarily limiting requests (not your usage limit)`

The older wordings in the brief ("Claude usage limit reached", "5-hour limit reached ∙ resets 3pm") no longer appear in the docs. relay should match on structured fields, not on text.

**Structured signals, best first:**

1. **`rate_limit_event` in the SDK and in stream JSON.** The TypeScript reference defines it as `{type:"rate_limit_event", rate_limit_info:{status:"allowed"|"allowed_warning"|"rejected", resetsAt?, utilization?, ...}, session_id}`, "Emitted when the session encounters a rate limit". The Python reference adds `rate_limit_type` with values `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` or `overage`, and says `utilization` runs "0.0 to 1.0" (https://code.claude.com/docs/en/agent-sdk/python#ratelimitevent). The two references list different fields, so relay should read the raw object. The event appears in the SDK. That it also appears in the raw `claude -p` stream is inferred: the SDK reads that stream, and the binary contains the string. The headless page does not list it.
2. **The `error` field.** It shows up as `"rate_limit"` on the assistant event, on `api_retry`, and on the StopFailure hook.
3. **The status line.** The status line is a user-configured command that receives JSON on every refresh (https://code.claude.com/docs/en/statusline). Its input includes `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage` (from 0 to 100) and `.resets_at` (Unix seconds). The docs say these "appear only for claude.ai Pro and Max subscribers ... and only after the first API response in the session". The status line runs only in interactive sessions. This is the only documented way to read the remaining percentage before a limit is hit, so a relay status-line command could record it. However, a user can have only one status line, so relay would have to call the user's existing one in turn.

**Automatic waiting at the limit.** Since version 2.1.234, an interactive subscription session that hits its limit waits and then continues by itself. It shows `Usage limit reached · limit resets 3:45pm` and `Continuing automatically at 3:45pm · esc to cancel` (https://code.claude.com/docs/en/interactive-mode). The setting is `autoContinueAtUsageLimit`. relay must decide whether to leave this on (see the decisions section).

**The usage endpoint is undocumented.** The address `/api/oauth/usage` appears only in third-party issues, not in Anthropic's documentation. relay should not use it.

**How limits work** (Help Center):

- "Your session-based usage limit will reset every five hours. Max plans also have a weekly usage limit" (https://support.claude.com/en/articles/11049741-what-is-the-max-plan).
- Usage on claude.ai, Claude Code and Claude Desktop "counts towards the same usage limit" (https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work).

### 1.5 Several accounts on one computer, and the terms

**The config directory override is officially documented for exactly this purpose.** The authentication page (https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts) says: "give each account its own configuration directory ... set the `CLAUDE_CONFIG_DIR` environment variable ... Each directory has its own settings, session history, and claude.ai login or API key." Its example is `alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`.

**Logins stay separate on macOS.** The same page says Claude Code "keys the macOS Keychain entry to that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry." On Linux the login is stored in `<config dir>/.credentials.json`. One caveat: "Separate directories don't keep two Claude Console sign-ins without an API key apart".

**Checking which account a directory holds.** `claude auth status` prints JSON that includes `authMethod` and `configDirectory`, and exits with 0 or 1.

**Other credentials.**

- `ANTHROPIC_API_KEY` always wins in `-p` mode when present.
- `claude setup-token` makes a one-year subscription token for `CLAUDE_CODE_OAUTH_TOKEN`. This token "can only make model requests".

**What the terms say,** quoted exactly:

- **Consumer Terms** (https://www.anthropic.com/legal/consumer-terms, effective October 8, 2025): "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else." Among prohibited uses: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." The Consumer Terms say nothing about one person holding several accounts.
- **Usage Policy** (https://www.anthropic.com/legal/aup): "Coordinate malicious activity across multiple accounts to avoid detection or circumvent product guardrails" and "Circumvent a ban through the use of a different account".
- **Claude Code legal page** (https://code.claude.com/docs/en/legal-and-compliance):
  - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
  - The page also says this does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
- **Agent SDK overview** (https://code.claude.com/docs/en/agent-sdk/overview): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- **Help Center, "Update June 15"** (https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): "We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits."

**What this means for relay.** This is my reading, not legal advice.

- relay is allowed to start the unmodified `claude` program on the user's own computer, in a config directory where the user signed in through Anthropic's own login.
- relay must never collect, store, copy or pass along Claude login tokens. It should only point `CLAUDE_CONFIG_DIR` at a folder the user signed into.
- Switching automatically between two Claude subscriptions in order to keep working past a limit is not clearly forbidden. It does sit uneasily with "ordinary, individual usage" and with "circumvent product guardrails". That is a founder decision.

### 1.6 Unattended runs

**Permission modes.** `--permission-mode` accepts `default` (alias `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk` and `bypassPermissions`. I confirmed this list in the local help output. The permission-modes page (https://code.claude.com/docs/en/permission-modes) describes three of them:

- `dontAsk`: "Reads and pre-approved tools; anything that would prompt is denied". It is recommended for "Locked-down CI and scripts".
- `auto`: a classifier reviews each action.
- `bypassPermissions`: "Isolated containers and VMs only". `--dangerously-skip-permissions` is the same thing.

Some actions are never approved automatically in any mode.

**Other controls:**

- `--permission-prompts none` denies anything that would prompt.
- `--allowedTools` and `--disallowedTools` take rules such as `"Bash(git diff *)"`.
- `--max-turns` and `--max-budget-usd` limit a run.

**The sandbox** (https://code.claude.com/docs/en/sandboxing):

- It is off by default and wraps only shell commands.
- It uses Seatbelt on macOS and bubblewrap on Linux.
- "Claude's file tools, MCP servers, and hooks run outside it."

**A sensible unattended default for relay:** `--permission-mode dontAsk` or `acceptEdits`, an explicit allow list for build and test commands, the sandbox turned on, and `--max-turns`.

### 1.7 Other features that matter to an orchestrator

- **Background sessions.** `claude --bg` starts a session in the background. Related commands are `claude agents`, `claude attach | logs | stop <id>` and `claude daemon status` (https://code.claude.com/docs/en/agent-view).
- **Remote control.** `claude remote-control` needs a subscription login, not an API key (https://code.claude.com/docs/en/remote-control).
- **The desktop app.** "Desktop runs the same underlying engine with a graphical interface ... you can bring a CLI session into Desktop." Resuming in the desktop app continues "the same session rather than a copy, so `claude --resume` in the terminal still finds it afterwards" (https://code.claude.com/docs/en/desktop). Two notes:
  - The exact storage path of a session started in the desktop app is not stated. It is not verified.
  - The desktop app does not read `ANTHROPIC_API_KEY`.

---

## 2. Codex (CLI, `codex exec`, app server, TypeScript SDK, desktop app)

Main sources: the source code at https://github.com/openai/codex (main branch, commit b17c74c of 2026-10-07), the app-server docs (https://learn.chatgpt.com/docs/app-server), non-interactive mode (https://learn.chatgpt.com/docs/non-interactive-mode) and the local help output of version 0.160.0.

### 2.1 The CLI and `codex exec`

**Starting a session.**

- An interactive session is `codex` or `codex "prompt"`.
- A non-interactive session is `codex exec "prompt"`.

**Flags I confirmed with `codex exec --help`:**

- `--json` ("Print events to stdout as JSONL")
- `-o, --output-last-message <FILE>`
- `--output-schema <FILE>`
- `--skip-git-repo-check`
- `-C, --cd <DIR>`
- `-s, --sandbox read-only|workspace-write|danger-full-access`
- `--dangerously-bypass-approvals-and-sandbox` (also `--yolo`)
- `-c key=value` (the value is read as TOML)
- `-p, --profile <name>`, which now layers a separate file, `$CODEX_HOME/<name>.config.toml`
- `--ephemeral` (saves nothing)
- `--ignore-user-config`
- `--dangerously-bypass-hook-trust`

**Two corrections to common assumptions:**

- **`--full-auto` is gone.** `codex exec --full-auto` now fails with `error: unexpected argument '--full-auto' found`. I confirmed this on this Mac. The docs still describe it as deprecated, but the binary no longer accepts it. Use `-s workspace-write` instead.
- **`exec` has no `-a/--ask-for-approval`.** Headless mode always sets the approval policy to "never". The source comment says: "Default to never ask for approvals in headless mode". To change it, pass `-c approval_policy="..."`.

**The events printed by `codex exec --json`** (codex-rs/exec/src/exec_events.rs):

- `thread.started` with `thread_id`. This is the ID relay saves in order to resume.
- `turn.started`.
- `turn.completed` with `usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`).
- `turn.failed` with `error.message`.
- `item.started`, `item.updated` and `item.completed`. The item types are `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list` and `error`.
- `error`.

These events carry no rate-limit numbers.

**Exit codes.** `exec` exits with 1 in these cases: an error that will not be retried, a turn that ends as `failed` or `interrupted`, or an approval request it cannot answer. Otherwise it exits with 0. No other exit codes were found.

**Interrupting.** Pressing Ctrl+C, or sending SIGINT, makes `exec` send an interrupt for the running turn. The turn ends as interrupted, and the process exits with 1.

**Resuming and forking** (confirmed in help):

- `codex exec resume <SESSION_ID or name> [PROMPT]`, with `--last` and `--all`.
- `codex exec fork <SESSION_ID>`.
- `codex resume` and `codex fork` for interactive sessions.
- Sessions started with `exec` are hidden from the interactive picker unless `--include-non-interactive` is passed.

**Other new subcommands:**

- `codex queue --thread <id> --message <text>`: "Queue a message for an existing session".
- `codex agents`: "Browse all agent sessions on the shared local app-server daemon".
- `codex archive`, `codex delete` and `codex migrate-rollouts`.

**Where sessions are stored.**

- The durable history is still JSONL "rollout" files at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
- SQLite databases sit beside them: `state_5.sqlite`, `thread_history_1.sqlite`, `queue_1.sqlite` and others. Since version 0.158, the "paginated history" is a SQLite index into the JSONL files. It does not replace them.
- Each line has the shape `{"timestamp", "type", "payload"}`, where `type` is `session_meta`, `response_item`, `event_msg`, `turn_context` or `compacted`.
- The source warns that readers must use Codex's own parser, so the format should be treated as internal.
- A single-writer lock per thread lives in `$CODEX_HOME/thread-writer-locks/`. The interactive program shows "This conversation is open in another app" when another process holds it. relay must not resume a thread that another live program still holds.

### 2.2 The app server protocol

`codex app-server` is the interface Codex itself uses to "power rich clients (for example, the Codex VS Code extension)" (https://learn.chatgpt.com/docs/app-server). The CLI labels it "[experimental]". The docs are more precise: "Core thread/turn/model APIs are stable. WebSocket transport is experimental and unsupported for production."

**Transport.**

- JSON-RPC 2.0 "without the `"jsonrpc":"2.0"` header", as one JSON object per line over standard input and output by default.
- `--listen` also accepts `unix://` and `ws://`.

**Handshake.** relay sends `initialize` with `clientInfo` and `capabilities` (set `experimentalApi: true` to use experimental methods). It then sends the `initialized` notification. Any request sent earlier receives the error "Not initialized".

**Methods relay needs** (codex-rs/app-server-protocol/src/protocol/common.rs):

- **Threads:** `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/read`, `thread/loaded/list`, `thread/compact/start` and `thread/revert`. (`thread/rollback` was removed.) There are also `thread/queue/*` methods, which are experimental.
- **Turns:** `turn/start`, `turn/steer` (which adds input to a running turn) and `turn/interrupt`. Example: `{"method":"turn/interrupt","id":31,"params":{"threadId":"thr_123","turnId":"turn_456"}}`.
- **Account:** `account/read` (account type, email and plan), `account/login/start` (by API key, browser or device code), `account/logout`, `account/rateLimits/read` and `account/usage/read`.
- **Hooks:** `hooks/list`.

**Notifications the server sends:**

- `thread/started`, `thread/status/changed`, `thread/tokenUsage/updated`
- `turn/started`, `turn/completed`
- `item/started`, `item/completed`, `item/agentMessage/delta`
- `hook/started`, `hook/completed`
- `account/rateLimits/updated`
- `error`

**What a failed turn looks like.** `turn/completed` carries `turn.status` (`completed`, `interrupted` or `failed`) and an optional `error`. The error has the shape `{message, codexErrorInfo}`. `codexErrorInfo` takes values such as `usageLimitExceeded`, `rateLimitExceeded`, `contextWindowExceeded`, `serverOverloaded` and `unauthorized`. This is the cleanest machine-readable usage-limit signal of all the tools in this report.

**Approval requests.** The server sends approval requests to the client:

- `item/commandExecution/requestApproval`, with possible answers `accept`, `acceptForSession`, `decline` and `cancel`.
- `item/fileChange/requestApproval`.

relay can answer these, or forward them to the person.

**Generated types.** `codex app-server generate-ts --out <DIR>` and `generate-json-schema` produce typed definitions that match the installed version.

**The shared local daemon.** This is new, and it matters for noticing sessions relay did not start.

- Since version 0.158 the interactive program starts and attaches to a shared background server by default. `codex features list` shows `daemon_auto_start stable true` on this Mac.
- Its socket is `$CODEX_HOME/app-server-control/app-server-control.sock`, readable only by the owner.
- `codex app-server proxy` "Proxy stdio bytes to the running app-server control socket". This gives any outside program a plain JSON-RPC pipe into the daemon.
- `thread/loaded/list` lists the threads the daemon has loaded. The `thread/resume` documentation says: "If thread_id identifies a running thread, app-server rejoins that thread". Together these suggest relay can observe a live session started in the terminal. I did not test this end to end.
- The daemon's README calls its lifecycle "experimental". It also warns that "per-client environment isolation is not provided". One daemon serves one `CODEX_HOME`, which means one account.
- `codex exec` does not use the daemon. It runs its own embedded server.

### 2.3 The TypeScript SDK (`@openai/codex-sdk` 0.160.1)

**How it works.** The README says: "The TypeScript SDK wraps the `codex` CLI ... It spawns the CLI and exchanges JSONL events over stdin/stdout." In practice it runs `codex exec --experimental-json`, and `codex exec ... resume <id>` to resume.

**API:**

- `new Codex({codexPathOverride, apiKey, config, env})`. When `env` is given, the SDK does not inherit the parent's environment, which makes `env: {CODEX_HOME: ...}` the way to choose an account.
- `codex.startThread(options)` and `codex.resumeThread(id, options)`.
- `thread.run(input)` and `thread.runStreamed(input)`.
- Thread options include `workingDirectory`, `sandboxMode`, `approvalPolicy`, `skipGitRepoCheck`, `networkAccessEnabled` and `model`.
- Interrupting means passing an `AbortSignal`, which kills the child process.

**What it inherits from `exec`.** Because it sits on top of `exec`, it also gets no rate-limit numbers.

**The Python SDK.** `openai-codex` is instead "Synchronous typed JSON-RPC client for `codex app-server` over stdio".

### 2.4 The desktop app

- "On July 9, the Codex app merged into the ChatGPT desktop app for macOS and Windows" (https://learn.chatgpt.com/docs/whats-new). The desktop app connects to the app server under the client name "Codex Desktop".
- The CLI command `/app` will "Continue the current session in the ChatGPT desktop app". It opens `codex://threads/{thread_id}`, because both read the same thread store in `CODEX_HOME`.
- `codex resume <id>` works in the other direction, once the app releases the thread's lock.
- "The CLI and IDE extension share the same cached credentials" (https://learn.chatgpt.com/docs/auth).
- Not verified: whether the desktop app attaches to the shared daemon or runs its own server.

### 2.5 Project instructions and injecting a handoff

**AGENTS.md discovery** (https://learn.chatgpt.com/docs/agent-configuration/agents-md):

- **Global level.** In `CODEX_HOME`, Codex "reads `AGENTS.override.md` if it exists. Otherwise, Codex reads `AGENTS.md`."
- **Project level.** "Starting at the project root (typically the Git root), Codex walks down to your current working directory." At each folder it takes one file, in this order: `AGENTS.override.md`, then `AGENTS.md`, then any names listed in `project_doc_fallback_filenames`.
- **Size limit.** The files are joined from the root down until `project_doc_max_bytes` is reached (32 KiB by default).
- **When.** They load "once per run".

**Config keys** (checked in the source, codex-rs/config/src/config_toml.rs):

- `developer_instructions` is "inserted as a `developer` role message".
- `model_instructions_file` replaces the built-in instructions. The source says users are "STRONGLY DISCOURAGED" from using it.
- The older `experimental_instructions_file` no longer exists.

**How relay can inject a handoff:**

- (a) Put it in the prompt.
- (b) Pass `-c developer_instructions="..."` on `codex exec` or `codex exec resume`, or set developer instructions in `thread/start` on the app server.
- (c) Use a SessionStart hook: "Plain text on stdout is added as extra developer context".
- (d) Rely on the AGENTS.md at the repository root.

### 2.6 Hooks and events

**`notify` (an older mechanism).** Codex runs a configured program with one JSON argument after each turn. The JSON has the shape `{"type":"agent-turn-complete","thread-id","turn-id","cwd","input-messages","last-assistant-message"}`. The source marks `notify` as legacy and due for removal. It also holds only one program, and this user's `~/.codex/config.toml` already uses it for another tool. relay must not overwrite it.

**Hooks (current mechanism).**

- They reached general availability on May 14, 2026 (https://learn.chatgpt.com/docs/whats-new). `codex features list` shows `hooks stable true`.
- **Locations:** `~/.codex/hooks.json`, a `[hooks]` table in `~/.codex/config.toml`, the project's `.codex/hooks.json`, and plugins (https://learn.chatgpt.com/docs/hooks).
- **Events:** PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop and Interrupt.
- **Input:** each hook receives `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `turn_id` and `model`.
- **Trust:** the hooks page says "Before a non-managed hook can run, Codex requires you to review and trust the exact hook definition". The person approves hooks through `/hooks`. relay therefore cannot silently install a working hook; the person must approve it once.
- **No limit hook:** there is no hook specific to usage limits. A Stop hook only says a turn ended.

**OpenTelemetry.** An `[otel]` config section can export events such as `codex.api_request` to an OpenTelemetry collector. OpenTelemetry is a standard format for logs and traces. This is a possible extra signal, but heavier to set up.

### 2.7 Usage and limit signals

**`/status`.** It shows rows such as "5h limit" and "weekly limit", each with "NN% left" and "(resets <time>)". The Help Center says: "In an active Codex CLI session, enter /status" (https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).

**The exact limit message.** It is defined in codex-rs/protocol/src/error.rs. Note the curly apostrophe in "You’ve". For a Plus plan it reads:

> You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at {time}.

Other plans get variants, for example "You’ve hit your usage limit. Try again at {time}." A limit on one model reads "You’ve hit your usage limit for {limit_name}. Switch to another model now, or try again at ...". The time is printed in local time, such as "3:45 PM", with the date added when the reset falls on another day.

**Machine-readable signals:**

- **The app server.** `account/rateLimits/read` returns `rateLimits` with `primary` and `secondary` windows. Each window is `{usedPercent, windowDurationMins, resetsAt}`, and `resetsAt` is in Unix seconds. The response also carries `planType`, `rateLimitReachedType` and a `rateLimitsByLimitId` map. The server pushes `account/rateLimits/updated` when these change. A failed turn carries `codexErrorInfo: "usageLimitExceeded"`. One source comment matters: "Null means unavailable; clients must not infer recovery from percentages or reset times."
- **`codex exec --json`.** It gives only the text of `turn.failed` or `error`, and exit code 1.
- **The session files.** They store `token_count` events with `rate_limits.primary.used_percent`, `window_minutes` and `resets_at`, but their format is internal.

**Shared limits.** The Help Center says: "Codex, ChatGPT Work, ChatGPT for Excel, and Workspace Agents use a shared allowance and credit pool". It also says: "Signing in again or repeatedly retrying does not restore your usage" (https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites).

### 2.8 Several accounts on one computer, and the terms

**`CODEX_HOME`.** It "defaults to `~/.codex`" and "stores config, auth, history, logs, caches" (https://learn.chatgpt.com/docs/config-file/config-advanced). The folder must already exist. The daemon, its socket, the sessions and the locks are all kept per `CODEX_HOME`.

**Logins stay separate.** `cli_auth_credentials_store` can be `file`, `keyring`, `auto` or `ephemeral`. With `file`, the login is in `CODEX_HOME/auth.json`. With the system keyring, the entry name is derived from a hash of the `CODEX_HOME` path (codex-rs/login/src/auth/storage.rs), so each folder keeps its own login. Login commands are `codex login`, `codex login --with-api-key` (reads the key from standard input), `--device-auth` and `codex login status`.

**What the terms say.** The OpenAI Terms of Use, effective January 1, 2026 (https://openai.com/policies/terms-of-use/), contain these sentences:

- "You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account."
- Under "What you cannot do": "Automatically or programmatically extract data or Output".
- Also under that heading: "Interfere with or disrupt our Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations we put on our Services."

Neither the Terms nor the Service Terms mention holding several accounts. The Help Center says the ChatGPT terms apply to Codex sign-ins.

**My reading.** Running Codex unattended through its own documented SDK and `exec` mode is plainly intended use. Moving to a second Codex account because the first hit its limit could be read as "circumvent any rate limits". relay should leave that choice to the person.

### 2.9 Unattended runs

**Approval policy** (`approval_policy`):

- `on-request` is the default; `on-failure` is now only another name for it.
- `never` means "Failures are immediately returned to the model".
- `granular` lets you set rules per kind of request.
- `untrusted` is retired (https://learn.chatgpt.com/docs/agent-approvals-security).

**Sandbox mode** (`sandbox_mode`): `read-only`, `workspace-write` or `danger-full-access`. Network access stays off unless `[sandbox_workspace_write] network_access = true` is set.

**Defaults.** `codex exec` forces "never" for approvals and uses a read-only sandbox unless told otherwise.

**`--approve-for-me`.** It routes approvals to an automatic reviewer agent.

**A sensible unattended command:**

```
codex exec --json -C <dir> -s workspace-write -c developer_instructions="..." -o <file> "<prompt>"
```

---

## 3. Cursor (the `agent` command-line program)

Main sources: https://cursor.com/docs/cli/ (overview, using, headless, reference pages), the CLI changelog (https://cursor.com/docs/cli/changelog), the hooks page (https://cursor.com/docs/agent/hooks), the terms (https://cursor.com/terms-of-service, last updated September 3, 2026), and the local help output of version 2026.09.18.

### 3.1 Start, message, stream, interrupt, resume

**Starting a session.** Interactive: `agent "prompt"`. Non-interactive: `agent -p "prompt"`. The local help says print mode "Has access to all tools, including write and shell."

**Streaming output.**

- `--output-format text|json|stream-json`.
- `--stream-partial-output` adds text as it is generated.

**Other useful flags:**

- `--model` and `--list-models`
- `--workspace <path>` and `--add-dir`
- `-w, --worktree [name]`, which works in its own git worktree under `~/.cursor/worktrees/`
- `--api-key` or `CURSOR_API_KEY`
- `--trust`, `--force`/`--yolo`, `--sandbox enabled|disabled` and `--auto-review`

There is no flag for setting a system prompt.

**The stream-json events** (https://cursor.com/docs/cli/reference/output-format):

```
{"type":"system","subtype":"init","apiKeySource":"env|flag|login","cwd":"...","session_id":"<uuid>","model":"...","permissionMode":"default"}
{"type":"user","message":{...},"session_id":"..."}
{"type":"assistant","message":{...},"session_id":"..."}
{"type":"tool_call","subtype":"started"|"completed","call_id":"...","tool_call":{...},"session_id":"..."}
{"type":"result","subtype":"success","duration_ms":...,"is_error":false,"result":"...","session_id":"..."}
```

The page also says these things about failures and changes:

- "On failure, the process exits with non-zero code and writes error messages to stderr ... for stream-json, the stream may end early without a terminal event."
- "consumers should ignore unknown fields".
- A February 2026 changelog entry adds per-turn token totals to stream-json, but their exact shape is not documented.

**Resuming.**

- `--resume [chatId]`, `--continue`, `agent resume` (the latest session) and `agent ls` (a picker).
- `agent create-chat` makes an empty chat and prints its ID, so relay can know the ID before the first prompt.
- The `session_id` in events is the same value the resume flag calls a chat ID.
- Not verified: that `--resume <id>` works together with `-p`. Testing it would have spent usage.

**Persistent sessions.** `agent persist` starts a session you can detach from and reattach to later with `agent persist attach` (changelog, v2026.08.26).

**Interrupting.** The only documented statement is "Interrupting keeps partial results" (changelog, v2026.01.26). How `-p` mode reacts to SIGINT or SIGTERM, and which exit code it returns, is not documented.

**Where chats are stored.** This is not documented. On this Mac they live under `~/.cursor/chats/<hash of the workspace path>/<chatId>/`, with a SQLite file per chat. Transcripts live under `~/.cursor/projects/<path>/agent-transcripts/`. relay should treat both as internal. Hooks receive a documented `transcript_path` field instead.

**The Cursor SDK** (https://cursor.com/docs/sdk/typescript, beta).

- It is installed with `npm install @cursor/sdk`.
- `Agent.create({apiKey, model, local:{cwd}})` and `Agent.resume(id)` start and resume an agent.
- `agent.send(prompt)` returns a run. `run.stream()` streams its events, and `run.cancel()` cancels it.
- `agent.getUsage()` returns usage and cost.
- It accepts user API keys, and it loads `.cursor/rules` and `.cursor/hooks.json`.

T3 Code uses this SDK for Cursor. There is also a cloud agents API at `https://api.cursor.com/v1/agents`, but it runs work on Cursor's machines, so it matters only if relay later hands work to the cloud.

### 3.2 Project instructions and injecting a handoff

**What the CLI reads.** The CLI page says (quote taken through the summarizer): "The CLI also reads `AGENTS.md` and `CLAUDE.md` at the project root (if present) and applies them as rules alongside `.cursor/rules`." Project rules must be `.mdc` files in `.cursor/rules/`, with a header containing `description`, `globs` and `alwaysApply` (https://cursor.com/docs/context/rules). A plain `.md` file in that folder is ignored.

**How relay can inject a handoff:**

- (a) Put it in the prompt.
- (b) Write a rule file such as `.cursor/rules/relay-handoff.mdc` with `alwaysApply: true`.
- (c) Rely on the root AGENTS.md.
- (d) Use the `sessionStart` hook's `additional_context`. The hooks page calls this hook "fire-and-forget", so the context might not arrive before the first turn.

### 3.3 Hooks

**Events** (https://cursor.com/docs/agent/hooks): sessionStart, sessionEnd, preToolUse, postToolUse, postToolUseFailure, subagentStart, subagentStop, beforeShellExecution, afterShellExecution, beforeMCPExecution, afterMCPExecution, beforeReadFile, afterFileEdit, beforeSubmitPrompt, preCompact, stop, afterAgentResponse and afterAgentThought.

**Input.** Every hook receives `conversation_id`, `generation_id`, `model`, `hook_event_name`, `workspace_roots` and `transcript_path`.

**The `stop` event.** It receives `status: "completed" | "aborted" | "error"`. It can return a `followup_message` that Cursor submits as the next user message.

**Where `hooks.json` lives:** the project's `.cursor/hooks.json`, the user's `~/.cursor/hooks.json`, and an enterprise path.

**Hooks in the CLI.** The changelog says the CLI supports session start and end, stop, pre-compaction and subagent hooks (January 2026). It also says the CLI reads Claude Code's `settings.json` hooks and merges them. No official table says which events fire in the CLI. A forum report says some do not (https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316).

**No limit hook.** No hook reports usage limits. A `stop` with `status: "error"` carries no reason.

### 3.4 Usage and limit signals

- **`/usage`.** It shows "your account's included-usage meters with Auto and API breakdowns, on-demand spend against your limit" (changelog, v2026.07.13). It works only in interactive sessions.
- **`agent about --format json`.** It returns `subscriptionTier` and `userEmail`, but no usage.
- **`agent status --format json`.** It returns login status only.
- **What happens at the limit.** "AI features stop working for that specific user", and "Enforcement is not instant" (https://cursor.com/help/account-and-billing/spend-limits).
- **The exact message.** The official docs do not quote the message text. Forum reports from the editor show "You've hit your usage limit". The CLI's text and exit code at the limit are not verified. The phrase does not appear in the CLI's own code, so it probably comes from Cursor's server. relay should treat "non-zero exit with no `result` event" as a possible limit and match the error text loosely.
- **Usage APIs.** The Admin API (`/teams/daily-usage-data`, `/teams/spend`) is for "Enterprise teams only" (https://cursor.com/docs/api). There is no documented usage endpoint for an individual user.

### 3.5 Several accounts on one computer, and the terms

**The config directory override does not separate logins on macOS.** `CURSOR_CONFIG_DIR` is documented on the configuration page (https://cursor.com/docs/cli/reference/configuration) as the place for `cli-config.json`. A read-only test with an empty folder still reported being signed in. That is because the login sits in the macOS Keychain under a name that does not depend on that folder. This comes from the installed program's code, not from documentation.

**The supported way to separate accounts is an API key per account.** Pass `CURSOR_API_KEY` or `--api-key` to each process. The keys come from each account's dashboard. The authentication page describes the key as being "For automated workflows or CI environments" (https://cursor.com/docs/cli/reference/authentication). The `apiKeySource` field in the `init` event confirms which credential a run used.

**The editor.** Cursor staff suggest `cursor --user-data-dir=...` per account, because "Each instance keeps its own login" (https://forum.cursor.com/t/feature-request-multi-account-support-fast-account-switching/166689, 2026-07-29).

**The founder notes' claim about staff statements is true.** These quotes came through the summarizer:

- Staff member Kevin Neilson, 2026-04-29: "Multiple accounts in Cursor in general are permitted as long its not abuse or account sharing ... you may have one account that's for work and one account that's for personal use - totally fine." (https://forum.cursor.com/t/second-cursor-account-for-students/159311)
- The same staff member, 2026-04-23: "Account sharing is against the Cursor terms of service ... We do have measures in place to protect against abuse" (https://forum.cursor.com/t/can-multiple-people-use-one-cursor-account/158868)

**What the terms say** (quoted exactly from the raw page). The Terms of Service do not mention account sharing, multiple accounts or getting around limits. The relevant sentences are:

- "You are solely responsible for maintaining the confidentiality of your account and password, and you accept responsibility for all activities that occur under your account."
- Under "Use Restrictions", you may not "rent, lease, lend, or sell the Service" or "harvest, scrape, or extract data from the Service".
- Cursor may "suspend, or discontinue the Services or your access to the Services ... at any time without notice", including for "preventing abuse".

### 3.6 Unattended runs

**What `-p` does without `--force` is unclear.** The local help says print mode has write and shell access. The headless page (https://cursor.com/docs/cli/headless) says "Without --force, changes are only proposed, not applied". relay should pass `--force` and `--trust` for unattended work and rely on deny rules for safety.

**Permission rules** (https://cursor.com/docs/cli/reference/permissions):

- They go in `~/.cursor/cli-config.json` or the project's `.cursor/cli.json`.
- The rule types are `Shell(cmd)`, `Read(glob)`, `Write(glob)`, `WebFetch(domain)` and `Mcp(server:tool)`.
- "Deny rules take precedence over allow rules", and `--force` still respects deny rules.

**Sandbox and approval modes.** `--sandbox enabled` blocks writes outside the workspace and blocks network access by default (https://cursor.com/docs/agent/security/run-modes). `approvalMode` can be `allowlist`, `auto-review` or `unrestricted`.

---

## 4. T3 Code

Main sources: the repository https://github.com/pingdotgg/t3code at main commit 611132c of 2026-10-07, its `docs/` folder, its pull requests and issues (read with `gh`), and https://t3.codes.

### 4.1 What it is

**What it does.** T3 Code is an open-source program, made by T3 Tools Inc., that drives other coding agents from one interface. It lets you work across "your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity" (README). The README calls it "an "agent harness control surface"". The website calls it "The open-source control plane for coding agents." Both phrases in the founder notes are confirmed.

**License.** MIT. The LICENSE file begins "MIT License / Copyright (c) 2026 T3 Tools Inc."

**Releases and versions.**

- The latest stable release is v0.0.45, published 2026-10-02 (https://github.com/pingdotgg/t3code/releases/tag/v0.0.45).
- The nightly build is 0.0.46-nightly.20261007.
- The app installed on this Mac is 0.0.40, an older build.

**Ways to run it:**

- An Electron desktop app.
- A command-line server: `npx t3@latest`, or `t3` after installing it.
- A hosted web client at https://app.t3.codes.
- Mobile apps.

### 4.2 Architecture

**The local server.**

- It is a Node.js server, published as the `t3` package, on default port 3773. Its flags include `--port`, `--host` and `--base-dir`.
- The desktop app bundles the same server.
- Its own clients talk to it over a WebSocket at `/ws` using JSON messages.
- The contract between them lives in `packages/contracts`.

**How it drives each provider** (the adapters are in `apps/server/src/orchestration-v2/Adapters/`):

- **Codex:** `CodexAdapterV2.ts` drives `codex app-server`.
- **Claude:** `ClaudeAdapterV2.ts` uses the Claude Agent SDK's `query()`.
- **Cursor:** `CursorAdapterV2.ts` uses the official `@cursor/sdk`. The new version "no longer use[s] the ACP transport".
- **OpenCode:** `OpenCodeAdapterV2.ts` uses `@opencode-ai/sdk/v2`.
- **Others:** there are also adapters for Grok, Pi, Antigravity and any ACP agent.

**State on disk.** T3 Code keeps its state under `~/.t3/`, which can be overridden by `--base-dir` or `T3CODE_HOME`. The main file is the SQLite database `userdata/statev2.sqlite`; the older version used `state.sqlite`. It also keeps settings, logs, attachments and `worktrees/`. The design document says "The event log is the source of truth for orchestration state", and checkpoints "use hidden Git refs to capture workspace state without adding commits to the user's branch."

### 4.3 What relay could use

**(a) The MCP server is the documented surface for outside programs.** It is served at `/mcp` (docs/user/outside-agents.md).

- Outside agents "can read projects and threads, start and message threads, and check which providers and models are available."
- Sign-in uses OAuth with a pairing code (`t3 auth pairing create`), and the person grants either read-only access or a permission ceiling.
- The tools found in the source include `t3_thread_list`, `t3_thread_read`, `t3_thread_send`, `t3_thread_wait`, `t3_thread_interrupt`, `t3_thread_launch`, `t3_thread_fork` and `delegate_task`.
- They also include `t3_thread_configure`, described as "Set a thread's provider, model and options". relay could therefore switch a T3 thread's provider from outside.

**(b) The WebSocket at `/ws` is internal.** It is versioned only between T3's own clients and servers, and it is not documented for others.

**(c) relay could appear inside T3 Code as a provider.** The new version can add "Settings → Providers → Add provider → Local ACP command" (docs/user/providers-acp.md). If relay offered an ACP interface, a T3 user could pick relay as a provider. This applies to nightly builds only for now.

**(d) The command-line program has no commands to send messages to threads.**

**(e) T3 Code is building overlapping features right now.** Three pull requests opened on 2026-10-07 by the main maintainer, none merged yet, are "Part of cross-environment orchestration":

- #16731 imports a thread's conversation.
- #16734 packages and applies a thread's git work.
- #16751 hands a thread off to a linked environment.

(https://github.com/pingdotgg/t3code/pull/16731, /16734, /16751)

**(f) A naming collision.** T3 already has a component called "T3 Connect Relay", "the hosted control plane for T3 Connect" (infra/relay/README.md).

### 4.4 The claim about switching providers inside a thread

The founder notes say: "As of October 2026, T3's Orchestrator V2 allows switching provider/model inside an existing thread. If it can't natively resume the provider session, it builds a portable context handoff from T3's stored conversation and starts a fresh session on the new provider. That exact feature was merged after users asked for Claude ↔ Codex switching when one provider was unavailable or out of quota."

**Verdict: mostly true, with three corrections.**

**What is true.** The design document says: "Provider switching is a first-class V2 feature. An app thread may contain runs from multiple providers while preserving each provider's native conversation handles and the app's canonical conversation history" (docs/orchestration-v2/provider-switching-and-context.md). The user documentation describes the handoff:

- "T3 Code transfers conversation context when you switch providers, continue through a portable restart, or use a fork that the provider cannot resume itself."
- "A handoff does not copy the outgoing provider's reasoning, tool-call state, or attachments."
- "A handoff is a budgeted selection, not an agent-written summary." The default budget is 16,000 tokens.

(docs/user/portable-handoffs.md)

In the code, a switch to a different provider always starts a fresh session with the handoff, and returning to the same provider tries a native resume first.

**Correction 1: it was not a single feature pull request.** It shipped inside the full orchestrator rewrite: pull request #2829, "feat(orchestrator): introduce new orchestrator", by @juliusmarminge, merged 2026-10-02 at 19:22 UTC (https://github.com/pingdotgg/t3code/pull/2829). I confirmed the title, author and merge time with `gh`. Its description says: "Closes #4944 — V2 owns provider switching through ProviderSwitchService/ProviderSessionTransitionPolicy/ProviderSessionManager". It also says: "Supersedes #8857 — V2 replaces the usage-limit handover draft with ContextHandoffServiceV2 portable handoffs plus Limited status and resume-at-reset". The pieces were built in earlier sub-PRs:

- #12352, "preserve budgeted history across provider handoffs", merged 2026-09-18 (https://github.com/pingdotgg/t3code/pull/12352).
- #13494, which tests "uses portable fallback when native resume fails after a provider switch" (https://github.com/pingdotgg/t3code/pull/13494).

**Correction 2: it is not in a stable release yet.** The merge came about an hour after v0.0.45 was published. I confirmed with `gh` that the merge commit is 5 commits ahead of v0.0.45. The feature therefore ships only in 0.0.46 nightly and preview builds. The maintainer's announcement, issue #14871, says "T3 Code Orchestrator V2 is SOON (est. 3am UTC) out in nightly builds" and lists "Switching providers mid-thread, plus native fork and rollback" (https://github.com/pingdotgg/t3code/issues/14871). The app installed on this Mac (0.0.40) does not have it.

**Correction 3: users did ask, but the pull request did not formally close their requests.**

- The main request is issue #3797, "[Feature]: Switch provider/model mid-conversation via transcript handoff" (https://github.com/pingdotgg/t3code/issues/3797). One commenter wrote: "I reached my quota in a long-running Claude Fable project thread, and alternate providers/models were disabled". It was closed on 2026-08-15 with no linked pull request.
- Related: discussion #7367 (https://github.com/pingdotgg/t3code/discussions/7367) and issue #10967, "Thread doesn't allow provider swap".
- Community pull requests such as #3799 were closed "in favor of #2829".

**Open bugs on the feature.** Several were filed this month, for example #15997, a handoff that fails with "Insufficient context allowance" (https://github.com/pingdotgg/t3code/issues/15997). Also, the internals document `docs/internals/context-handoffs.md` still describes the older approach, with summaries clipped to 240 characters, and appears out of date.

### 4.5 Resume, interruption, permissions and limits in T3 Code

**Resuming by provider:**

- Codex: app-server `thread/resume` and `thread/fork`.
- Claude: the SDK's `resume` and `forkSession`.
- Cursor: the SDK's `resume`.
- OpenCode: `resumeThread`.

**Interrupting.** The Stop button stops the thread and "also stops the subagents it delegated to".

**Permission modes.** There are four modes: Supervised, Auto-accept edits, Auto and Full access. "The initial default is **Full access**." For Claude they map to `default`, `acceptEdits`, `auto` and `bypassPermissions`.

**Usage limits.** A thread is shown as "Limited" when "the provider stopped on a usage or rate limit". The person can choose "Resume at reset" or "Auto-resume limited threads". A usage page "pools every subscription account it can see per provider" and shows 5-hour and other windows with their reset times.

**Several accounts.**

- Codex accounts that share one `CODEX_HOME` through "shadow homes" can continue a thread natively.
- For Claude: "Existing threads can switch only between Claude instances with the same config directory". This sentence may predate the portable handoff.

### 4.6 Project instructions in T3 Code

T3 Code relies on each underlying agent to read its own files.

- **For Claude,** it uses the `claude_code` preset system prompt and appends a short block of its own. It does not limit `settingSources`, so CLAUDE.md loads as usual. That last point is inferred from the SDK's documented default.
- **For Codex,** it sends only short developer instructions and leaves AGENTS.md to Codex.

---

## 5. OpenCode

Main sources: the repository, which moved from `github.com/sst/opencode` to https://github.com/anomalyco/opencode (read at tag v1.18.30, the installed version), and the docs at https://opencode.ai/docs/.

### 5.1 Start, message, stream, interrupt, resume

**Starting a session.**

- Interactive: `opencode`.
- Non-interactive: `opencode run "message"`. Its flags include `--format json`, `-s/--session <id>`, `-c/--continue`, `--fork`, `-m provider/model`, `--agent`, `-f/--file`, `--attach <url>` and `--auto` (all confirmed in local help).

**Events from `opencode run --format json`.** Each line has the shape `{"type", "timestamp", "sessionID", ...}`. The type is one of:

- `step_start`
- `text`
- `tool_use`
- `step_finish`, which carries cost and tokens
- `reasoning`
- `error`

The process exits with 1 if any session error occurred.

**The HTTP server.** `opencode serve` starts it (https://opencode.ai/docs/server/).

- The port prefers 4096. The host defaults to 127.0.0.1.
- `OPENCODE_SERVER_PASSWORD` turns on HTTP basic authentication.
- The full OpenAPI description is at `GET /doc`.
- Main endpoints:
  - `POST /session` creates a session.
  - `POST /session/:id/message` sends a message and waits for the reply.
  - `POST /session/:id/prompt_async` sends without waiting.
  - `POST /session/:id/abort` interrupts.
  - `POST /session/:id/fork` and `POST /session/:id/summarize`.
  - `GET /session/status`.
  - `GET /event` and `GET /global/event` are the event streams.
- One server can serve many project folders, chosen per request with a header or a `?directory=` query.

**Events on the stream:**

- `session.status`, with the shape `{type:"idle"}`, `{type:"busy"}` or `{type:"retry", attempt, message, next, action?}`.
- `session.error`.
- `message.updated`, `message.part.updated` and `message.part.delta`.
- `permission.asked` and `permission.replied`.
- `session.idle` still exists but is marked deprecated in the source. relay should watch `session.status` instead.

**The SDK.** `@opencode-ai/sdk` provides `createOpencode()`, which starts a server, and `createOpencodeClient({baseUrl})`, which connects to one. OpenCode's own `run` command uses the newer `@opencode-ai/sdk/v2` interface.

**Resuming and interrupting.** Resume by sending to the same session ID, or with `opencode run -s <id>`. Interrupt with `POST /session/:id/abort`.

**Where sessions are stored.**

- Sessions are now in a SQLite database, `~/.local/share/opencode/opencode.db`. `opencode db path` prints its location.
- `opencode export <id>` writes a session as JSON with the shape `{info, messages:[{info, parts}]}`, and `opencode import` reads it back.
- The troubleshooting page still describes the older JSON-file layout and is out of date.

**ACP.** `opencode acp` speaks ACP over standard input and output.

### 5.2 Project instructions and injecting a handoff

**What OpenCode reads** (https://opencode.ai/docs/rules/):

- In the project, it takes the first match walking upward among `AGENTS.md`, then `CLAUDE.md`, then the deprecated `CONTEXT.md`. Only one name is used, so AGENTS.md wins over CLAUDE.md.
- Globally, it reads `~/.config/opencode/AGENTS.md`, falling back to `~/.claude/CLAUDE.md`.
- `OPENCODE_DISABLE_CLAUDE_CODE=1` turns off all reading of Claude's files.
- An `instructions` array in the config adds more files. The docs say: "All instruction files are combined with your `AGENTS.md` files."

**How relay can inject a handoff:**

- (a) Put it in the prompt and attach `.relay/checkpoint.md` with `-f`.
- (b) Set the environment variable `OPENCODE_CONFIG_CONTENT='{"instructions":[".relay/checkpoint.md"]}'` for the child process.
- (c) Use the `system` field of the HTTP message request.
- (d) Define an agent file and run it with `--agent`.

### 5.3 Hooks and noticing stops

**Plugins** (https://opencode.ai/docs/plugins/).

- Plugins live in `.opencode/plugins/`, `~/.config/opencode/plugins/` or npm packages.
- They are JavaScript functions with hooks such as `event`, `chat.message`, `tool.execute.before`, `tool.execute.after` and `permission.ask`.
- The `event` hook receives every bus event, including `session.status` and `session.error`. A small relay plugin could forward these to relay.

**Watching a session from outside depends on how it was started.** The docs say "When you run `opencode` it starts a TUI and a server". In version 1.18.30, however, the interactive program and plain `opencode run` use an in-process connection and open no network port, unless `--port`, `--hostname` or `--mdns` is passed. An outside program therefore cannot watch a session started plainly. relay's options are:

- Start `opencode serve` itself and have sessions attach to it with `opencode attach <url>` or `opencode run --attach <url>`.
- Install a global plugin.
- As a last resort, read the database through `opencode db --format json`.

### 5.4 Usage and limit signals

**Provider errors.** OpenCode talks to many model providers. Their errors arrive as `session.error` with one of these shapes:

- `{name:"APIError", data:{message, statusCode, isRetryable, responseHeaders, responseBody}}`
- `{name:"ProviderAuthError", ...}`
- `MessageAbortedError`, `ContextOverflowError` and a few others

**Retries.** Before giving up, OpenCode retries up to 5 times. It honors `retry-after` headers and otherwise waits 2 seconds, doubling up to 30 seconds. During retries it publishes `session.status` with `{type:"retry", attempt, message, next}`, where `next` is a time in milliseconds. For OpenCode's own paid services, `action.reason` can be `free_tier_limit` or `account_rate_limit`.

**What relay sees at a limit.** A provider's 429 error that survives all retries arrives as `APIError` with `statusCode: 429`.

**Cost and tokens.** Each assistant message carries `cost` and `tokens`. `opencode stats` prints a table, with no JSON option.

**Not verified:** whether OpenCode reads any "remaining quota" information from subscription providers.

### 5.5 Several accounts, and the subscription-login issue

**Directories.**

- Logins (`auth.json`) and the session database follow `XDG_DATA_HOME`.
- The config follows `XDG_CONFIG_HOME` or `OPENCODE_CONFIG_DIR`.
- Setting both for each child process isolates one account.
- `opencode auth login`, `opencode auth list` and `opencode auth logout` manage logins.

**Claude subscriptions are no longer supported in OpenCode.** The providers page says: "There are plugins that allow you to use your Claude Pro/Max models with OpenCode. Anthropic explicitly prohibits this. Previous versions of OpenCode came bundled with these plugins but that is no longer the case as of 1.3.0" (https://opencode.ai/docs/providers/#anthropic). The v1.3.0 release notes say "Removed anthropic oauth plugin". relay should use OpenCode with Anthropic API keys only.

**ChatGPT subscriptions are supported.** ChatGPT Plus and Pro login is officially supported; the docs say "We recommend signing up for ChatGPT Plus or Pro" (https://opencode.ai/docs/providers/#openai). GitHub Copilot uses a device-code login.

### 5.6 Unattended runs

**Permission rules** (https://opencode.ai/docs/permissions/).

- Each rule is `allow`, `ask` or `deny`, per tool or per command pattern, for example `"bash": {"*":"ask","git *":"allow","rm *":"deny"}`.
- The last matching rule wins.
- Most tools default to `allow`. `doom_loop` and `external_directory` default to `ask`.

**`--auto`.** It "auto-approve[s] permissions that are not explicitly denied". Hidden aliases are `--yolo` and `--dangerously-skip-permissions`.

**Without `--auto`, `opencode run` rejects questions.** It prints `permission requested: ... auto-rejecting` and rejects the request.

**Recommendation.** For unattended runs, relay should pass explicit allow and deny rules through `OPENCODE_PERMISSION` or `OPENCODE_CONFIG_CONTENT`.

---

## 6. Capability table

Each cell names the best official way to do the thing. "Not documented" means I found no supported way.

| Provider | Start | Stream | Interrupt | Resume | Inject handoff | Hooks | Usage signal | Several accounts | Unattended mode |
|---|---|---|---|---|---|---|---|---|---|
| Claude Code | `claude -p`, or the Agent SDK `query()` | `--output-format stream-json --verbose`; input by `--input-format stream-json` | SIGINT ends the turn cleanly; SDK `interrupt()`; SIGTERM exits with 143 | `--resume <id>`, `--session-id`, `--fork-session` | prompt, `--append-system-prompt[-file]`, SessionStart hook context, CLAUDE.md (`@AGENTS.md`) | Yes, in user settings: Stop, StopFailure (with `rate_limit`), Notification, SessionStart and SessionEnd, PreCompact; also `claude agents --json` | `rate_limit_event` (status, reset time, use); status line `rate_limits` (5-hour and 7-day percent, reset time); documented limit messages | `CLAUDE_CONFIG_DIR`, documented for this purpose, with separate Keychain entries | `--permission-mode dontAsk / acceptEdits / auto / bypassPermissions`, allow lists, sandbox, `--max-turns` |
| Codex | `codex exec`; app server `thread/start` + `turn/start`; TypeScript SDK | `exec --json` lines; app-server notifications | SIGINT in exec; app-server `turn/interrupt` | `codex exec resume <id>`; `thread/resume`; `fork` | prompt, `-c developer_instructions=`, AGENTS.md, SessionStart hook | Yes, hooks (stable, the person must trust each one): Stop, SessionStart and SessionEnd, PreCompact, Interrupt; legacy `notify`; shared daemon socket via `codex app-server proxy` | Best of all five: `account/rateLimits/read` (`usedPercent`, `resetsAt`, `windowDurationMins`), `codexErrorInfo: usageLimitExceeded`; exec gives only text and exit 1 | `CODEX_HOME`, documented, with the keyring separated per folder | `-s workspace-write`, `approval_policy` (`never` in exec), network off by default |
| Cursor CLI | `agent -p`; Cursor SDK `Agent.create` | `--output-format stream-json`, `--stream-partial-output` | SDK `run.cancel()`; CLI signals not documented | `--resume <chatId>`, `create-chat`, `agent persist` | prompt, `.cursor/rules/*.mdc`, AGENTS.md or CLAUDE.md, `sessionStart` context (may arrive late) | Yes, `~/.cursor/hooks.json`: stop (completed, aborted or error), sessionStart and sessionEnd, preCompact; CLI coverage partly verified | Weak: `/usage` in interactive mode only; no documented message or exit code at the limit | Config folder does not separate logins on macOS; use one API key per account | `--force --trust`, allow and deny rules, `--sandbox enabled`, `--auto-review` |
| T3 Code | MCP tool `t3_thread_launch` / `t3_thread_send` (needs pairing) | MCP `t3_thread_wait` / `t3_thread_read`; `/ws` is internal | MCP `t3_thread_interrupt` | Native per provider, plus a portable handoff (nightly only) | message text; T3 relies on each agent's own files | No hooks of its own; MCP polling; relay could register as an ACP provider | Shows "Limited" and reset times in its own interface; no documented outside reading | Provider instances per account (Codex "shadow homes") | Four modes; the default is Full access |
| OpenCode | `opencode run`; `opencode serve` + `POST /session` | `--format json`; SSE `/event` with `session.status` | `POST /session/:id/abort` | `-s <id>`, `--continue`, `--fork`; `export` / `import` | prompt, `-f`, `instructions` via `OPENCODE_CONFIG_CONTENT`, `system` field, AGENTS.md | Plugins (`event` hook) and the SSE bus; plain interactive sessions open no port | `session.status` retry with `next` time; `APIError` with `statusCode` 429 and headers | `XDG_DATA_HOME` + `XDG_CONFIG_HOME` (or `OPENCODE_CONFIG_DIR`) | permission rules, `--auto` |

---

## 7. Proposed adapter interface

The interface below only promises what at least two real tools provide, and it lets each adapter declare what it cannot do. It is written in TypeScript notation because three of the five tools ship official TypeScript SDKs. The same shape works in any language.

```ts
// An execution target is one provider plus one account, such as "claude:personal".
interface ExecutionTarget {
  provider: "claude" | "codex" | "cursor" | "opencode" | "t3";
  account: string;
  // What makes this account separate on disk or in the environment:
  // CLAUDE_CONFIG_DIR, CODEX_HOME, CURSOR_API_KEY, XDG_DATA_HOME + XDG_CONFIG_HOME.
  env: Record<string, string>;
}

interface Capabilities {
  streamingInput: boolean;      // can send messages into a running turn (Claude, Codex app server, OpenCode)
  cleanInterrupt: boolean;      // can end a turn without killing the process
  nativeResume: boolean;        // resume by provider session ID
  limitPercentBeforeHit: boolean; // can read "percent used" before the limit (Codex app server, Claude status line)
  limitSignalOnHit: "structured" | "text" | "none";
  observesExternalSessions: "hooks" | "socket" | "poll" | "none";
}

interface ProviderAdapter {
  readonly provider: string;
  detect(): Promise<{ installed: boolean; version: string; capabilities: Capabilities }>;

  // Accounts. relay never handles the login itself; it only checks it.
  authStatus(target: ExecutionTarget): Promise<{ signedIn: boolean; method: string; detail?: string }>;
  loginCommand(target: ExecutionTarget): string[]; // the provider's own login command, for the person to run

  // Work.
  start(target: ExecutionTarget, req: StartRequest): Promise<WorkerHandle>;
  send(worker: WorkerHandle, text: string): Promise<void>; // throws if !streamingInput while a turn runs
  interrupt(worker: WorkerHandle): Promise<void>;
  resume(target: ExecutionTarget, providerSessionId: string, req: StartRequest): Promise<WorkerHandle>;
  events(worker: WorkerHandle): AsyncIterable<WorkerEvent>;

  // Capacity.
  availability(target: ExecutionTarget): Promise<Availability>;

  // Sessions relay did not start. Changes the person's own config, so it needs consent.
  installObserver?(target: ExecutionTarget): Promise<{ filesChanged: string[]; needsUserTrust: boolean }>;
  readonly policy: ProviderPolicy;
}

interface StartRequest {
  cwd: string;                   // the job's worktree
  prompt: string;                // "Read .relay/task.md and .relay/checkpoint.md, verify, continue."
  handoffFile?: string;          // .relay/checkpoint.md, delivered by the best channel the tool has
  model?: string;
  permission: "read-only" | "edit-in-workspace" | "full-access";
  maxTurns?: number;
}

type WorkerEvent =
  | { kind: "session_started"; providerSessionId: string }
  | { kind: "message"; role: "assistant"; text: string }
  | { kind: "tool"; name: string; status: "started" | "completed" | "failed"; detail?: unknown }
  | { kind: "turn_completed"; usage?: TokenUsage; costUsd?: number }
  | { kind: "turn_failed"; reason: FailureReason; resetsAt?: Date; message: string }
  | { kind: "limit_update"; windows: LimitWindow[] }
  | { kind: "approval_needed"; requestId: string; summary: string }
  | { kind: "exited"; code: number | null };

type FailureReason = "usage_limit" | "rate_limit" | "overloaded" | "auth" | "context_full" | "interrupted" | "other";

interface LimitWindow { name: string; usedPercent?: number; resetsAt?: Date; source: string }

interface Availability {
  state: "available" | "rate_limited" | "quota_exhausted" | "unavailable" | "unknown";
  retryAt?: Date;
  windows: LimitWindow[];
  observedAt: Date;
  source: "provider_api" | "stream_event" | "hook" | "message_text" | "user";
}

interface ProviderPolicy {
  termsUrls: string[];
  allowAutoSwitchBetweenOwnAccounts: boolean; // set by the founder per provider, see decisions
  notes: string;
}
```

**How each part maps to real features.**

- **`start`, `send`, `interrupt` and `resume`.**
  - Claude: `claude -p --input-format stream-json --output-format stream-json --verbose`, or the Agent SDK.
  - Codex: `codex app-server` with `thread/start`, `turn/start`, `turn/interrupt` and `thread/resume`.
  - Cursor: `agent -p --output-format stream-json --resume`, or the Cursor SDK.
  - OpenCode: the HTTP server's session endpoints.
- **`turn_failed.reason = "usage_limit"`.**
  - Claude: the `error: "rate_limit"` field, `rate_limit_event` with `status: "rejected"`, or the StopFailure hook.
  - Codex: `codexErrorInfo: "usageLimitExceeded"`.
  - Cursor: a non-zero exit without a result event, plus a loose text match.
  - OpenCode: `APIError` with status 429.
- **`limit_update`.**
  - Claude: `rate_limit_event`, and the status line when relay is allowed to add one.
  - Codex: `account/rateLimits/updated`.
  - Cursor and OpenCode: nothing.
- **`handoffFile`.**
  - Claude: `--append-system-prompt-file`.
  - Codex: `-c developer_instructions` or thread developer instructions.
  - Cursor: a temporary `.cursor/rules/relay-handoff.mdc`.
  - OpenCode: `OPENCODE_CONFIG_CONTENT` instructions.
  - Every tool also gets the same pointer in the prompt.
- **`installObserver`.**
  - Claude: Stop, StopFailure, Notification, SessionStart and SessionEnd hooks in each `CLAUDE_CONFIG_DIR`'s `settings.json`.
  - Codex: hooks in each `CODEX_HOME`, which the person must trust once in `/hooks`. Optionally relay can also attach to the daemon socket through `codex app-server proxy`.
  - Cursor: `~/.cursor/hooks.json`.
  - OpenCode: a global plugin.

**Two design rules this research supports.**

- **Adapters must never parse session transcript files.** Claude, Codex and Cursor all describe their transcript formats as internal and changing. relay should store the provider session ID and use each tool's own resume command.
- **An availability reading must say where it came from.** Only Codex gives a dependable "percent used and reset time" through an API. Claude gives one in stream events and the status line. Cursor and OpenCode give nothing before the limit is hit. The scheduler must therefore know which readings are measured and which are guessed.

---

## 8. The first two adapters to build, and why

**1. Codex, through the app server.**

- It has the best control surface of all five tools. It offers start, resume, fork, interrupt and steer as named methods.
- Its approval requests can be answered.
- It is the only tool with a dependable usage reading before the limit (`account/rateLimits/read`) and a structured reason when the limit is hit (`usageLimitExceeded`).
- The protocol can generate its own types (`generate-ts`). The core methods are documented as stable.
- It is what Codex's own desktop app, VS Code extension and T3 Code use.
- Each account is cleanly separated by `CODEX_HOME`.
- `codex exec --json` should be the simpler fallback, but it gives no limit numbers.

**2. Claude Code, through `claude -p` in stream-JSON mode, or through the Agent SDK if relay's daemon is written in TypeScript.**

- The founder uses it most.
- It has the richest hook system: StopFailure carries `rate_limit`, and hooks in user settings let relay notice sessions it did not start, including desktop-app sessions.
- `CLAUDE_CONFIG_DIR` is documented exactly for running several accounts.
- `rate_limit_event` gives reset times.
- Together, Claude and Codex make the demo in VISION.md possible: start in Claude, hit the limit, continue in Codex.

**Why not the others first.**

- **Cursor** has no reliable limit signal and no supported way to separate logins other than API keys.
- **OpenCode** cannot be watched from outside unless relay starts its server, and its Claude use requires API keys.
- **T3 Code** should be an integration rather than an adapter at first. The cheapest route is to let T3 users add relay as an ACP provider, or to drive T3 through its MCP tools. Its own provider switching is not yet in a stable release.

---

## 9. Decisions only the founder can make

1. **Switching between two accounts of the same provider.** Anthropic's terms say Pro and Max limits "assume ordinary, individual usage" and forbid using several accounts to "circumvent product guardrails". OpenAI's terms forbid attempts to "circumvent any rate limits". Neither forbids owning two accounts outright. Choose one of three policies:
   - (a) relay switches accounts only on an explicit command from the person.
   - (b) relay asks before each switch.
   - (c) relay switches automatically.

   I recommend (a) or (b) for the first version. Switching from one provider to another provider raises no such issue.
2. **The daemon's language.** Official TypeScript SDKs exist for Claude, Codex, Cursor and OpenCode. A TypeScript daemon can use them directly, as T3 Code does. A Rust or Go daemon would speak the same line-based protocols itself. This choice also affects the Mac app.
3. **Whether relay may edit the person's agent settings to install hooks or plugins.** This means `~/.claude/settings.json` in each config directory, `~/.codex/hooks.json` (which the person must also approve in `/hooks`), `~/.cursor/hooks.json` and an OpenCode plugin. Without this, relay only sees sessions it starts itself.
4. **The default permission level for unattended work.** The options run from "edit inside the workspace, sandbox on, deny network" to "full access". T3 Code defaults to full access. Claude's docs reserve full bypass for "Isolated containers and VMs only". The founder's AWS Linux machine could be the place where full access is allowed.
5. **What to do about Claude's automatic wait at the limit.** Since version 2.1.234, interactive Claude sessions wait for the reset and continue on their own (`autoContinueAtUsageLimit`). relay must either turn this off for sessions it manages, or treat "waiting for reset" as a state of its own.
6. **How relay relates to T3 Code.** T3 Code already does in-thread provider switching (nightly only), shows "Limited" threads, pools subscription usage, and opened cross-environment handoff pull requests today. Choose one:
   - (a) integrate: offer relay as an ACP provider inside T3, or drive T3 through MCP;
   - (b) stay beside it and focus on scheduling across accounts, jobs and machines;
   - (c) both.

   Also, T3 already has a component named "T3 Connect Relay", which matters for the product name.
7. **Cursor accounts by API key.** Logins are not separated by `CURSOR_CONFIG_DIR` on macOS, so running two Cursor accounts at once means using one API key per account. Decide whether that is acceptable, or whether Cursor support stays single-account at first.
8. **Desktop apps are viewers, not something relay drives.** relay would observe the Claude and Codex desktop apps through hooks and the Codex daemon, and hand work to them through each tool's own resume (Codex `/app`, `claude --resume`). It would not automate their windows. Confirm this boundary.

---

## 10. What could not be verified

- **Claude: exit code at a usage limit.** The exact exit code of `claude -p` at a usage limit is not documented; the docs only say it is non-zero.
- **Claude: `rate_limit_event` in the raw stream.** Whether it appears in raw `claude -p` stream JSON, as opposed to the SDK, is inferred and was not observed.
- **Claude: desktop session paths.** The storage path of sessions started in the desktop app is not stated.
- **Claude: the February 2026 legal text.** An earlier version of the Claude Code legal page, quoted by the press in February 2026, said subscription tokens in "any other product, tool, or service — including the Agent SDK — is not permitted". That sentence is not on the live page today. I could not retrieve the archived official version.
- **Codex: attaching to a live session.** Whether a second client on the Codex daemon can attach to a live terminal session was not tested end to end.
- **Codex: hooks in exec mode.** That hooks fire under `codex exec` is implied by a flag, not stated.
- **Codex: which server the desktop app uses.** Whether the Codex desktop app uses the shared daemon is not stated.
- **Cursor: behavior at the limit.** The CLI's message and exit code at a usage limit are not documented.
- **Cursor: interruption.** How `-p` mode handles SIGINT and SIGTERM is not documented.
- **Cursor: `--resume` in print mode.** Whether `--resume` works with `-p` was not tested.
- **Cursor: hooks in the CLI.** Which hooks fire in the CLI is only partly verified.
- **Cursor: key versus login.** The order of precedence between an API key and a stored login is not stated.
- **Cursor: forum quotes.** Some Cursor forum quotes came through a summarizer and should be checked by eye.
- **OpenCode: plugin server address.** The plugin's `serverUrl` value when the interactive program uses its in-process connection is not verified.
- **OpenCode: subscription quota headers.** Whether OpenCode reads subscription quota headers is not verified.
- **T3 Code: Cursor and OpenCode rule files.** Whether T3 Code's Cursor and OpenCode adapters load project rule files was not checked.
