# Tasks

Every task is one small pull request. Following AGENTS.md, edit on the Mac and run every command
below on the Omarchy machine (the `jstack-remote-build` skill), except where a task says it needs
Josué's Mac. "design.md N" means decision N in this change's design.md. Tests never call a real
provider or a real T3 Code: they use the fake T3 server of task 4.1, phase 3's `fake-claude` and
`fake-codex`, and phase 5's injectable clock.

## 1. Checks before building

- [ ] 1.1 Needs Josué's Mac and Josué. Install the latest T3 Code nightly, turn on Settings →
  Auto-resume limited threads, and run a throwaway script built on `@modelcontextprotocol/sdk`
  from the scratchpad that signs in to `/mcp` with a loopback redirect address and a pairing code
  from `t3 auth pairing create`, calls `orchestrator_capabilities`, restarts T3, and calls it
  again. Write the answers in `docs/research/t3-outside-access.md` under "What I could not
  verify": whether the loopback redirect was accepted, the instance IDs before and after the
  restart, and the T3 build. Verify by reading the updated section; if the redirect was refused,
  stop this change and ask Josué (design.md 3).
- [ ] 1.2 Run `claude -p "/usage"` three times on the Omarchy machine with a signed-in
  Claude account, with `/usage` in the account's statistics before and after, and check whether a
  session transcript appears under `~/.claude/projects/`. Also check whether
  `claude --no-session-persistence` exists (`claude --help`). Save the outputs, with any account
  e-mail removed, to `test/fixtures/usage/claude-usage*.txt`, and write the answers in the same
  research section. Verify by reading the section. If `/usage` spends usage or prints no weekly
  percentage, remove the Claude reader (task 3.3) from this change and record that in design.md 6.
- [ ] 1.3 Compare the interfaces design.md "Context" lists with the approved code of phases 1, 3,
  4 and 5, and write any difference at the top of `docs/t3.md` (created here with a one-paragraph
  summary). Rename identifiers in this change's design.md and specs only where an approved name
  differs. Verify with `npx --yes @fission-ai/openspec@latest validate add-t3-limit-rules
  --strict`, which must print `Change 'add-t3-limit-rules' is valid`.

## 2. Settings and the rules engine

- [ ] 2.1 Add the `[t3]`, `[t3.instances.<id>]` and `[limits."<account>".<window>]` tables to
  phase 1's settings schema, `docs/config.md` and `docs/config.example.toml` (design.md 5). Verify
  with `bun test test/config/t3-settings.test.ts test/config/limits-settings.test.ts`, which cover
  every scenario of the `t3-connection` requirement "T3 settings" and of the `limit-rules`
  requirements "Rule settings" and "Switch targets are checked", each with exit code 78.
- [ ] 2.2 Add `src/limits/rules.ts` with the defaults of the `limit-rules` requirement
  "Defaults". Verify with `bun test test/limits/rules.test.ts`, which covers both default
  scenarios, a rule with every key set, and `action = "wait"` with a `switch_to` (the target is
  ignored and `relay t3 status` says so).
- [ ] 2.3 Add `src/limits/crossings.ts`, the pure engine of design.md 7. Verify with
  `bun test test/limits/crossings.test.ts`, which covers both scenarios of the requirement
  "Crossing a threshold", a window with no reset time, a stale reading (no crossing), and readings
  of two accounts that never affect each other.

## 3. Usage readings

- [ ] 3.1 Add `src/usage/codex.ts` over phase 3's Codex reading, naming windows by minutes.
  Verify with `bun test test/usage/codex.test.ts` using `fake-codex`, which covers the scenario
  "Both windows" (including `2026-10-12T16:00:00.000Z`), a 43200-minute window kept without a
  name, and a reading error giving no windows.
- [ ] 3.2 Add `src/usage/claude.ts`: the command of the `usage-readings` requirement "Claude
  readings" and the parser chosen in task 1.2. Verify with `bun test test/usage/claude.test.ts`
  using `fake-claude` and the fixtures of task 1.2, which covers both scenarios of that
  requirement, the 30-second time limit, standard input at end of file, the working folder, and
  that `ANTHROPIC_API_KEY` set in the test is not passed to the child.
- [ ] 3.3 Add `src/usage/timer.ts` to the daemon (design.md 6): the 5-minute timer, the hook
  trigger, one reading per account at a time, storage as availability windows, and the
  `usage_reading` event. Verify with `bun test test/usage/timer.test.ts`, which covers every
  scenario of the `usage-readings` requirements "Which accounts are read and how often",
  "Readings are honest" and "Readings are recorded" with the injectable clock.

## 4. Connecting to T3 Code

- [ ] 4.1 Add `test/fakes/fake-t3.ts` (design.md 12): an MCP server built with the SDK's server
  classes on a random `127.0.0.1` port, with the tools of design.md 1, scripted projects and
  threads, OAuth endpoints with a fixed pairing code, a call log, and switches for `401`, "no
  answer" and "old build" (no `t3_thread_configure`). Verify with `bun test
  test/fakes/fake-t3.test.ts`, which lists the tools, runs one scripted thread from `running` to
  `failed`, and checks the call log.
- [ ] 4.2 Add `@modelcontextprotocol/sdk` with `bun add` and `src/t3/client.ts`: the Streamable
  HTTP client, the tool allow list, two retries 30 seconds apart, and `logs/t3.log` without
  message text, titles or the token (design.md 1). Verify with `bun test test/t3/client.test.ts`,
  which checks that calling `t3_thread_merge_back` throws before any request reaches the fake
  server, the retry timing with the injectable clock, and that the log never contains the fake
  token or a thread title.
- [ ] 4.3 Add `src/t3/oauth.ts` (design.md 3 and 4): the `OAuthClientProvider`, the loopback
  listener, and storage with `Bun.secrets`. First confirm that the pinned Bun has `Bun.secrets`;
  if not, stop and report it. Verify with `bun test test/t3/oauth.test.ts`, which signs in to the
  fake server with an injected browser opener, checks a wrong `state` is refused, checks the
  listener closes after 120 seconds, and checks the scenario "Nothing on disk" by searching every
  file under `RELAY_HOME`.
- [ ] 4.4 Add `relay t3 connect` with the version check and the instance mapping questions
  (`t3-connection` requirements "Connecting" and "Mapping T3 providers to relay accounts"). Verify
  with `bun test test/t3/connect.test.ts`, which runs the command in a pseudo-terminal against the
  fake server and covers every scenario of both requirements, including exit codes 40, 41 and 7,
  and that `config.toml` keeps its comments after the mapping is written.
- [ ] 4.5 Add `relay t3 status`, `relay t3 disconnect` and the expiry rules (`t3-connection`
  requirements "Expiry", "Disconnecting" and "Connection status"). Verify with `bun test
  test/t3/status.test.ts`, which covers each scenario, the warning 3 days before expiry with the
  injectable clock, the `--json` output, and exit code 42.

## 5. Acting on threads

- [ ] 5.1 Add `relay t3 enable` and `relay t3 disable` (`t3-thread-actions` requirement "Enabling
  a project"), using phase 4's allow list question. Verify with `bun test test/t3/enable.test.ts`,
  which covers all three scenarios and a folder reached through a symbolic link.
- [ ] 5.2 Add `src/t3/watcher.ts`: the 60-second loop, project matching, and thread selection
  (design.md 8, steps 1 and 2). Verify with `bun test test/t3/watcher.test.ts`, which covers both
  scenarios of the requirement "Which threads a switch applies to", a thread in a project that is
  not enabled, a thread on another account, and a project whose allow list lacks the target.
- [ ] 5.3 Add the grace period and interruption (design.md 8, step 3). Verify with `bun test
  test/t3/interrupt.test.ts`, which covers both scenarios of the requirement "Waiting for the turn
  to end", a `waiting` turn left alone after 30 minutes, and exactly one `t3_thread_interrupt`
  call per turn.
- [ ] 5.4 Add `src/t3/actions.ts`: switching and sending `continue` (design.md 8 step 4 and
  design.md 9). Verify with `bun test test/t3/actions.test.ts`, which covers every scenario of the
  requirements "Switching the thread", "Sending continue" and "Actions are visible and safe", a
  daemon restart between the switch and the send (no second switch, one send), and that every
  `t3_thread_send` call's message is exactly `continue`.
- [ ] 5.5 Add `src/limits/notify.ts` (design.md 10). Verify with `bun test
  test/limits/notify.test.ts`, which replaces `osascript` and `notify-send` with recording fakes
  on `PATH` and covers both scenarios of the requirement "What each action does" about
  notifications, and one notification per crossing.

## 6. The whole night, and documents

- [ ] 6.1 Add `test/e2e/t3-night.test.ts`: the fake T3 server with two enabled-project threads
  on `claude`, `fake-claude` readings rising from 85 to 91 percent weekly, and `fake-codex`. With
  the injectable clock, check that one thread finishing its turn is switched without a message,
  the other is interrupted after 15 minutes, switched and sent `continue` once, a thread in a
  project that is not enabled is untouched, and `relay t3 status` lists both actions. Verify
  with `bun test test/e2e/t3-night.test.ts`.
- [ ] 6.2 Write `docs/t3.md` (connecting, the `full-access` level and why, the profile folder
  example of design.md 5, turning on T3's auto-resume, the last T3 build checked) and update
  `docs/ROADMAP.md` (record the T3 decision of 2026-10-08 for the adapter part and place this
  change at the start of phase 7) and the private task board (this change's tasks). Verify by running
  `grep -n "add-t3-limit-rules" docs/ROADMAP.md`, which must print at least one line.
- [ ] 6.3 Needs Josué's Mac and Josué. With the T3 nightly from task 1.1, run `relay t3
  connect`, `relay t3 enable` on a scratch project, set `[limits."claude:personal".seven_day]
  threshold` to a value just below the current reading, start a long turn in a T3 thread, and
  check that relay switches it to Codex and sends `continue`. Record the T3 build, the times and
  `relay t3 status --json` in the pull request. Verify by reading that record.
