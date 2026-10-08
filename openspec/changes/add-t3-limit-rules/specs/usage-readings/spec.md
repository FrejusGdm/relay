# Spec Delta: usage-readings

## Purpose

A threshold rule can only act before a limit is hit if relay knows how much of each window an account has used. T3 Code does not share its numbers with outside programs, so relay measures them itself, through each provider's own documented interface, and says honestly when it has no reading.

## ADDED Requirements

### Requirement: Which accounts are read and how often
While relay is connected to T3 and at least one project is enabled, the daemon SHALL read every account named by a `[t3.instances.<id>]` table or by a rule's `switch_to`, every 5 minutes, and once more within 10 seconds after a Claude `StopFailure` hook with `error` `rate_limit` is attributed to that account. Two readings of the same account SHALL NOT run at the same time.

#### Scenario: Timer
- **WHEN** relay is connected, one project is enabled and `claude:personal` is mapped
- **THEN** the fake clock advancing 5 minutes starts one Claude reading for `claude:personal`

#### Scenario: Limit hook
- **WHEN** a `StopFailure` hook with `error` `rate_limit` arrives for the profile folder of `claude:personal`
- **THEN** a reading of `claude:personal` starts within 10 seconds

#### Scenario: Nothing enabled
- **WHEN** no project is enabled
- **THEN** no reading runs

### Requirement: Codex readings
For a Codex account the daemon SHALL use phase 3's Codex availability reading (`codex app-server` with the account's `CODEX_HOME`, `account/rateLimits/read`). A window of 300 minutes SHALL be named `five_hour` and a window of 10080 minutes `seven_day`; any other window SHALL be kept as `<n>_minutes`, and no rule applies to it.

#### Scenario: Both windows
- **WHEN** the answer has `primary` at 62 percent with 300 minutes and `secondary` at 91 percent with 10080 minutes and `resetsAt` 1791820800
- **THEN** the reading has `five_hour` 62 and `seven_day` 91 with `resets_at` `2026-10-12T16:00:00.000Z`, and source `provider_api`

### Requirement: Claude readings
For a Claude account the daemon SHALL run `claude -p "/usage"` with the account's `CLAUDE_CONFIG_DIR`, the credential environment rules of phase 3, standard input at end of file, a working folder of `RELAY_HOME/run/usage`, and a 30-second time limit, and SHALL read the session and weekly percentages and reset times from its output with the parser chosen in task 1.2. The weekly window for all models SHALL be named `seven_day`; per-model weekly windows SHALL be ignored.

#### Scenario: Recorded output
- **WHEN** the fake `claude` prints the recorded output in `test/fixtures/usage/claude-usage.txt`, which shows 34 percent of the session and 91 percent of the week
- **THEN** the reading has `five_hour` 34 and `seven_day` 91 with source `usage_command`

#### Scenario: Output not understood
- **WHEN** the output contains no percentage relay recognizes
- **THEN** the reading has no windows, the reason "relay could not read Claude's /usage output.", and a `usage_reading_failed` log line with the first 200 characters of the output

### Requirement: Readings are honest
Each reading SHALL carry its account, windows, source and `measured_at`. A window older than 15 minutes SHALL count as not measured for rules. relay SHALL never estimate a percentage, never add percentages of different accounts, and never carry a reading from one account to another.

#### Scenario: Stale reading
- **WHEN** the newest `seven_day` reading of `claude:personal` is 20 minutes old
- **THEN** no rule acts on that window, and `relay t3 status` shows `seven_day: not measured since <time>`

### Requirement: Readings are recorded
Every reading SHALL be stored as the account's availability windows used by `relay status` (phase 5), and SHALL append a `usage_reading` event to the daemon's event stream. Readings SHALL NOT be written to any project's `.relay/` folder.

#### Scenario: Status shows the reading
- **WHEN** a reading gives `claude:personal` 91 percent weekly
- **THEN** the `claude:personal` row of `relay status` shows the `seven_day` window at 91 percent, rendered as phase 5 renders windows, with the time it was measured
