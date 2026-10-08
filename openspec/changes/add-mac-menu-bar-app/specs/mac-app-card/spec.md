# Spec Delta

## Purpose

The menu-bar card shows one relay job at a glance: which agent works on it, where it came from,
what was saved and when an account resets, in words and only from what the daemon reported. It
follows `DESIGN.md` and the tiny and expanded card of `docs/design/preview.html`.

## ADDED Requirements

### Requirement: Menu-bar app without a Dock icon
The app SHALL be a `MenuBarExtra` with the window style, SHALL have no Dock icon (`LSUIElement`), and SHALL show the relay glyph as a template image whose accessibility label is "relay: " followed by the status line or the state title in plain text.

#### Scenario: Accessibility label after a handoff
- **WHEN** Codex runs after a handoff from a rate-limited Claude Code account
- **THEN** the icon's accessibility label is "relay: Moved to Codex · Claude Code reached its limit"

### Requirement: Which job is shown
The menu-bar card SHALL show the job with the newest `updated_at` among jobs whose current worker is `running` or `starting`, and otherwise the job with the newest `updated_at`.

#### Scenario: A running job wins
- **WHEN** job `aaaaaaaa` has a running worker and job `bbbbbbbb` has none but a newer `updated_at`
- **THEN** the card shows job `aaaaaaaa`

### Requirement: Tiny card by default
The menu-bar window SHALL open on the tiny card (280 points wide): the job title, the repository line, the status line, and a row with the checkpoint note on the left and the primary action on the right. Clicking the card outside the primary action SHALL expand it to the expanded card with a 180 ms ease-out change, or instantly when the person reduces motion.

#### Scenario: Tiny card after a handoff
- **WHEN** Codex runs on `codex:personal` after a handoff
- **THEN** the tiny card's note reads "Same checkpoint & plan" and its action names Codex

#### Scenario: Reduced motion
- **WHEN** "Reduce motion" is on and the person clicks the tiny card
- **THEN** the expanded card appears with no animation

### Requirement: Expanded card order
The expanded card SHALL show, in this order: the head with "Show less" and "Quit"; the job title and repository line; the status line; the previous and current worker rows with the connector; the facts list; the primary action; then "View checkpoint" and "Switch worker…" when they apply.

#### Scenario: One worker only
- **WHEN** the job has had exactly one worker
- **THEN** the card shows one worker row and no connector

### Requirement: Status line in words
The status line SHALL be chosen by the first matching case: "Moved to <current> · <previous> reached its limit"; "Moved to <current> · from <previous>" (or "Moved to <current>" without a previous worker); "<current> is working"; "Starting <current>"; "<current> stopped · relay did not record why"; "Limit reached · <last> resets <time>" or "· <last> reset unknown"; "No agent is working on this job". Provider names SHALL come from the account's `provider_name`, then "Claude Code" for `claude` and "Codex" for `codex`.

#### Scenario: Handoff after a limit
- **WHEN** the current Codex worker has `from_handoff` true and the previous worker's account `claude:work` is `rate_limited` with a future `retry_at`
- **THEN** the status line is "Moved to Codex · Claude Code reached its limit"

#### Scenario: Limit with no running agent
- **WHEN** no worker runs and the last worker's account is `rate_limited` with `retry_at` today at 18:00
- **THEN** the status line is "Limit reached · Claude Code resets 18:00"

#### Scenario: Stopped without a record
- **WHEN** the current worker's state is `stopped`
- **THEN** the status line is "Codex stopped · relay did not record why"

### Requirement: Honest availability and capacity
Account words SHALL follow the phase 5 words (Available, Limit reached, Out of quota, Unavailable, Unknown), a `rate_limited` or `quota_exhausted` account whose `retry_at` has passed SHALL show "Unknown · reset time passed", a missing reset time SHALL show "reset unknown", and a usage bar SHALL appear only when the account's `usage` is not empty, labelled with the percentage, the window and the time it was measured. The card SHALL never show a total across accounts and SHALL never show a status by color alone.

#### Scenario: Stale reset time
- **WHEN** `claude:work` is `rate_limited` with a `retry_at` one minute in the past
- **THEN** its row shows "Unknown · reset time passed"

#### Scenario: No usage reported
- **WHEN** `codex:personal` has `usage` `[]`
- **THEN** its row shows no bar and no percentage

#### Scenario: Usage reported
- **WHEN** `claude:home` reports 9 percent used in the `five_hour` window measured at 14:30
- **THEN** its row shows a bar and "9% used · 5-hour window · checked 14:30"

### Requirement: Facts
The facts list SHALL show "Checkpoint" with the first 6 characters of the last checkpoint's commit and its time, or "None yet", and SHALL show "Carried over: Repository, checkpoint & plan" only when the current worker came from a handoff. It SHALL NOT show test results.

#### Scenario: No checkpoint
- **WHEN** the job's `last_checkpoint` is `null`
- **THEN** the facts list shows "Checkpoint" with "None yet" and the "View checkpoint" button is absent

### Requirement: Primary action opens a view
The primary action SHALL be "Open <provider> in <app>" when the current worker is `running` or `starting` and an ancestor process of its `pid` (at most 32 steps) is a regular app, and SHALL bring that app forward. Otherwise it SHALL be "Show project in Finder", which selects `project_root` in Finder; when the project is missing there SHALL be no primary action. The primary action SHALL NOT send any request to the daemon.

#### Scenario: Agent in Terminal
- **WHEN** the current Codex worker's process descends from Terminal
- **THEN** the button reads "Open Codex in Terminal" and pressing it activates Terminal and sends no request

#### Scenario: Headless worker
- **WHEN** no ancestor of the worker's process is a regular app
- **THEN** the button reads "Show project in Finder"

#### Scenario: Missing project
- **WHEN** the job has `project_missing` true
- **THEN** the repository line reads "Project folder not found" and there is no primary action

### Requirement: Checkpoint sheet
"View checkpoint" SHALL open a sheet with the checkpoint number in the title, the full commit, the saved time, the kind in words, the message when it is not empty, and the ref, with "Copy commit" and "Close".

#### Scenario: Handoff checkpoint
- **WHEN** the last checkpoint has kind `handoff`
- **THEN** the sheet's "Kind" row reads "Saved at a handoff"

### Requirement: States without a job
The card SHALL show the titles and texts of design decision 9 when the app is connecting, when relay is not running, when a folder or socket check fails, when the daemon is too old, and when there are no jobs, and SHALL offer "Copy command" where that table gives a command.

#### Scenario: Not running
- **WHEN** the socket does not exist
- **THEN** the card shows "relay is not running" and "Start it in a terminal: relay daemon start", and "Copy command" puts `relay daemon start` on the clipboard

#### Scenario: No jobs
- **WHEN** `GET /v1/jobs` returns `{"jobs":[]}`
- **THEN** the card shows "No jobs yet" and "Run relay init in a project to start one."

### Requirement: Design tokens and type
The views SHALL use the color tokens of `DESIGN.md` for light and dark appearance, following the system setting, and the typefaces Public Sans 700 for the expanded title (design decision 13), Public Sans for text and IBM Plex Mono for hashes, job IDs, targets and commands, loaded from the app bundle.

#### Scenario: Dark appearance
- **WHEN** the screenshots are rendered with the dark color scheme
- **THEN** the card background is `#161614` and the active worker's border uses the dark accent `#BDCDA0`
