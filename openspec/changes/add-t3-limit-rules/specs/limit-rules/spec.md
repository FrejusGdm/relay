# Spec Delta: limit-rules

## Purpose

Each person uses their subscriptions differently. Limit rules let the person say, for each account and each usage window, how much of the window relay may use and what to do after that: let the limit reset, move the work to another provider, or only tell them.

## ADDED Requirements

### Requirement: Rule settings
`config.toml` SHALL accept tables `[limits."<account>".<window>]`, where `<account>` is an account defined under `accounts` and `<window>` is `five_hour` or `seven_day`, with the keys `threshold` (a whole number from 1 to 100), `action` (`"wait"`, `"switch"` or `"notify"`) and `switch_to` (an account). Any other key, window or value SHALL be a settings problem with exit code 78.

#### Scenario: Threshold out of range
- **WHEN** `[limits."claude:personal".seven_day]` sets `threshold = 120`
- **THEN** the problem list contains `limits."claude:personal".seven_day.threshold: must be a whole number from 1 to 100.`

#### Scenario: Unknown window
- **WHEN** `config.toml` has `[limits."claude:personal".monthly]`
- **THEN** the problem list contains `limits."claude:personal".monthly: unknown window. Use five_hour or seven_day.`

### Requirement: Defaults
A window with no table, or a table that leaves out a key, SHALL use these defaults: for `five_hour`, `threshold` 100 and `action` `"wait"`; for `seven_day`, `threshold` 90 and `action` `"switch"` when `switch_to` is set and `"notify"` otherwise.

#### Scenario: No rules written
- **WHEN** `config.toml` has no `[limits]` table and `claude:personal` is mapped to a T3 instance
- **THEN** `relay t3 status` lists `claude:personal · five_hour: wait at 100%` and `claude:personal · seven_day: notify at 90%`

#### Scenario: Only a target written
- **WHEN** `[limits."claude:personal".seven_day]` sets only `switch_to = "codex:personal"`
- **THEN** the rule is `switch` at 90 percent to `codex:personal`

### Requirement: Switch targets are checked
`action = "switch"` SHALL require `switch_to`. `switch_to` SHALL be an account of a different provider than the rule's account, and SHALL be named by a `[t3.instances.<id>]` table. A `switch_to` of the same provider SHALL be a settings problem, with the reason from `provider-policies`.

#### Scenario: Same provider
- **WHEN** `[limits."claude:work".seven_day]` sets `switch_to = "claude:home"`
- **THEN** the problem list contains `limits."claude:work".seven_day.switch_to: relay does not move work between two Claude accounts on its own. Anthropic's terms say plan limits assume ordinary, individual use.`

#### Scenario: Switch without a target
- **WHEN** a rule sets `action = "switch"` and no `switch_to`
- **THEN** the problem list contains `limits."claude:personal".seven_day.switch_to: is required when action is "switch".`

#### Scenario: Target not in T3
- **WHEN** `switch_to = "codex:personal"` and no `[t3.instances.<id>]` table names `codex:personal`
- **THEN** the problem list contains `limits."claude:personal".seven_day.switch_to: T3 Code has no provider mapped to codex:personal. Run relay t3 connect to map it.`

### Requirement: Crossing a threshold
A rule SHALL be crossed when a fresh reading (see `usage-readings`) shows the window's percentage at or above its threshold. relay SHALL record a crossing once per account, window and reset time, by appending a `limit_crossed` event with the account, window, percentage, threshold, action and `resets_at`. A crossing SHALL end when a later reading shows the window below the threshold or when `resets_at` has passed. A window with no reset time SHALL stay crossed until a reading is below the threshold.

#### Scenario: Crossed once
- **WHEN** three readings in a row show `claude:personal` weekly at 90, 92 and 93 percent with the same `resets_at`, and the threshold is 90
- **THEN** exactly one `limit_crossed` event is appended

#### Scenario: New week
- **WHEN** the weekly window of `claude:personal` was crossed, its `resets_at` passes, and the next reading shows 4 percent
- **THEN** the crossing ends, and a later crossing in the new week is recorded again

### Requirement: What each action does
`wait` SHALL do nothing beyond recording the crossing. `notify` SHALL show one desktop notification per crossing: `<Provider> · <account name> has used <n>% of its <window> limit. relay is not moving any work.`, where `<window>` is "5-hour" for `five_hour` and "weekly" for `seven_day`, using `osascript` on macOS and `notify-send` on Linux when it is installed. `switch` SHALL hand the crossing to `t3-thread-actions`. A rule SHALL never act on a window that is not measured.

#### Scenario: Notify on macOS
- **WHEN** the `seven_day` rule of `claude:personal` is `notify` at 90 and a reading shows 91 percent
- **THEN** relay runs `osascript` once with the text `Claude · personal has used 91% of its weekly limit. relay is not moving any work.`

#### Scenario: No notifier on Linux
- **WHEN** the same happens on Linux and `notify-send` is not installed
- **THEN** relay only records the crossing, and `relay t3 status` shows it
