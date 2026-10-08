# Spec Delta

## Purpose

`relay status` shows, in a few lines, which job is running, its latest checkpoint, and what every
account can do right now. It reads like the relay card: one lane per account, honest about what
relay could not measure.

## ADDED Requirements

### Requirement: Which job is shown
`relay status` SHALL show the job of the relay project that contains the current directory, or the job given with `--job <id>`. Outside a project and without `--job`, it SHALL print "This folder is not in a relay project. Run relay init here, or pass --job <id>." and exit 3, the code `add-checkpoint-engine` uses for "relay is not set up here".

#### Scenario: Inside a project
- **WHEN** the person runs `relay status` in a subfolder of a project whose job is 3f9a2c1d
- **THEN** the output is about job 3f9a2c1d

#### Scenario: Outside a project
- **WHEN** the person runs `relay status` in their home folder
- **THEN** the command prints the not-in-a-project message and exits 3

### Requirement: Header line
The first line SHALL be the job title, three spaces, then `job <id> · checkpoint <first 6 characters of the commit hash> · <age>`, or `job <id> · no checkpoint yet` when the job has none.

#### Scenario: With a checkpoint
- **WHEN** job 3f9a2c1d, titled "Build authentication", has checkpoint `912ec1…` saved 2 minutes ago
- **THEN** the first line is `Build authentication   job 3f9a2c1d · checkpoint 912ec1 · 2 min ago`

### Requirement: One row per account
After a blank line, the output SHALL have one row per configured account: the account id, a lane 16 characters wide, and its state in words. When a worker is current, the previous worker's account comes first, then the current one, then the rest in alphabetical order, and a step line joins the previous lane to the current one.

#### Scenario: After a handoff
- **WHEN** job 3f9a2c1d moved from `claude:work` to `codex:personal` and `claude:home` is configured
- **THEN** the rows appear in the order `claude:work`, `codex:personal`, `claude:home`, the `claude:work` lane contains `┐`, a line with `│` follows it, and the `codex:personal` lane is drawn with `━` and contains `┷`

#### Scenario: No handoff yet
- **WHEN** job 3f9a2c1d has only ever run on `claude:work`
- **THEN** no step is drawn and `claude:work` is the first row

### Requirement: Availability in words
Each row SHALL describe the account with exactly one of: `running`, `stopped`, `available`, `limit reached`, `out of quota`, `unavailable`, `unknown`. Limited rows SHALL add `resets <time>` when the reset time is known and `reset unknown` otherwise. A row with no measurement SHALL say `not measured`.

#### Scenario: Limit with a known reset
- **WHEN** `claude:work` is `rate_limited` with `retry_at` today at 18:00 local time
- **THEN** its row ends with `limit reached · resets 18:00`

#### Scenario: Limit with no reset time
- **WHEN** `claude:work` is `rate_limited` with `retry_at` `null`
- **THEN** its row ends with `limit reached · reset unknown`

#### Scenario: Never measured
- **WHEN** `claude:home` has no availability measurement and no running worker
- **THEN** its row ends with `unknown · not measured`

### Requirement: Usage is per account, never combined
A row SHALL show usage only when the account reported a measurement, as `<n>% used (<window name>, checked <time>)`. The output SHALL NOT contain any sum, average or total across accounts, in text or JSON.

#### Scenario: Measured usage
- **WHEN** `claude:home` reported 9 percent used of its five-hour window at 14:30
- **THEN** its row contains `9% used (5-hour window, checked 14:30)`

#### Scenario: Several measured accounts
- **WHEN** two accounts report 40 and 60 percent used
- **THEN** the output shows each percentage on its own row and no other percentage appears

### Requirement: Closing sentence
After a blank line, the output SHALL end with `Continuing on <provider name>.` when the current worker started from a handoff, `<provider name> is working on this job.` when it did not, or `No agent is working on this job.` when there is no running worker.

#### Scenario: After a switch to Codex
- **WHEN** the current worker on `codex:personal` started from a handoff
- **THEN** the last line is `Continuing on Codex.`

### Requirement: Styling only on a terminal
On a terminal, when `NO_COLOR` is unset and `TERM` is not `dumb`, the current row SHALL be bold and limited or unavailable rows SHALL be dim. Otherwise the output SHALL contain no escape sequences and SHALL be otherwise identical.

#### Scenario: Piped output
- **WHEN** the person runs `relay status | cat`
- **THEN** the output contains no byte `0x1b`

### Requirement: JSON mode
`relay status --json` SHALL print one JSON object with `schema` set to `relay.status/v1`, `daemon` (`running` or `not_running`), `saved_state` (`true` when the view was built from the files), `job`, `checkpoint`, `accounts` and `generated_at`. Unknown values SHALL be `null`, never omitted, and nothing else SHALL be printed.

#### Scenario: JSON for an unmeasured account
- **WHEN** `codex:personal` was never measured
- **THEN** its entry has `availability.status` `unknown`, `availability.retry_at` `null` and `usage` `[]`

### Requirement: Works when the daemon is down
`relay status` SHALL ask the daemon with a 300 ms timeout and SHALL NOT start it. When the daemon does not answer, it SHALL build the same view from the project's files, the spool and a read-only copy of `relay.db` if present, add the line `Showing saved state. The relay daemon is not running.`, and exit 0.

#### Scenario: Daemon stopped
- **WHEN** the daemon is not running and the person runs `relay status` in job 3f9a2c1d's project
- **THEN** the output shows job 3f9a2c1d with its last checkpoint, ends with the saved-state line, no daemon is started, and the exit code is 0

#### Scenario: Same answer either way
- **WHEN** `relay status --json` runs once with the daemon and once without, with no changes in between
- **THEN** the two outputs are equal except for `daemon`, `saved_state` and `generated_at`
