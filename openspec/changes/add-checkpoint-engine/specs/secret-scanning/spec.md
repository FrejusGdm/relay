# Spec Delta: secret-scanning

## Purpose

Secrets must never reach a checkpoint, because checkpoint commits may later be shared. This capability scans everything relay is about to store in a checkpoint and stops on a finding, without ever printing or storing the secret itself.

## ADDED Requirements

### Requirement: Every checkpoint is scanned before it is recorded
Before recording any checkpoint, of any kind, relay SHALL scan with gitleaks the lines the checkpoint adds compared with its parent, the full text of the `.relay/` job files, and the checkpoint message. On a finding relay SHALL create no ref, change no `.relay/` file other than appending the event, and exit with code 4.

#### Scenario: Token in an untracked file
- **WHEN** `src/config.ts` contains a GitHub personal access token on line 12 and the person runs `relay checkpoint`
- **THEN** relay prints:
  ```
  Stopped: possible secret in src/config.ts line 12 (github-pat).
  Nothing was saved. Remove the secret, or move it to an ignored file such as .env, then run relay checkpoint again.
  ```
- **AND** exits with code 4 and no new ref exists under `refs/relay/`

#### Scenario: Secret in a job file
- **WHEN** `.relay/decisions.md` contains an AWS secret access key
- **THEN** the checkpoint stops with a message naming `.relay/decisions.md` and the line

#### Scenario: Secret in the message
- **WHEN** the person runs `relay checkpoint -m "use token ghp_…"` with a real-looking token
- **THEN** the checkpoint stops and the message names `(checkpoint message)`

#### Scenario: Several findings
- **WHEN** the scan finds four possible secrets
- **THEN** relay prints one "possible secret in <path> line <n> (<rule>)" line for each, at most 20, followed by "and <k> more" when there are more

#### Scenario: Secrets already committed are not scanned again
- **WHEN** a file committed on the person's branch before `relay init` contains a secret, and the person changes another line of that file
- **THEN** the checkpoint is not stopped by the old secret, because only added lines are scanned

### Requirement: Scanning texts that are not files yet
relay SHALL offer one function, `scanTexts`, that scans a list of labelled texts with the same gitleaks command, configuration and clean-up as a checkpoint scan, and returns for each finding the label, the line and the rule, never the secret.

#### Scenario: Token in a prompt
- **WHEN** a caller scans the parts `the prompt for Codex` and `Claude Code's handoff notes`, and the notes hold a GitHub token on line 3
- **THEN** the result is one finding with label `Claude Code's handoff notes`, line 3 and rule `github-pat`, and the token appears in no output and no file under `RELAY_HOME`

### Requirement: Secret values are never shown or stored
relay SHALL NOT print, log, write to `.relay/` files or events, or keep on disk the text of a finding. The `checkpoint_refused` event SHALL hold only the reason `secret_found` and, for each finding, `path`, `line` and `rule`. Temporary scan files SHALL be created with mode 0600 and deleted when the command ends, whether it succeeds or fails.

#### Scenario: Event without the secret
- **WHEN** a checkpoint is stopped by a finding of the token `ghp_` followed by 36 characters
- **THEN** the new `checkpoint_refused` event contains `path`, `line` and `rule`, and neither `events.jsonl`, the terminal output nor any file under `RELAY_HOME` contains the token

### Requirement: The repository cannot weaken the scan
relay SHALL run gitleaks with its own configuration (gitleaks' default rules), an empty ignore file, and inline allow comments disabled, so that a `.gitleaks.toml`, `.gitleaksignore`, `gitleaks:allow` comment or `GITLEAKS_CONFIG` variable cannot hide a finding. relay SHALL never let gitleaks run git.

#### Scenario: Allow comment written by an agent
- **WHEN** a line with a token ends with the comment `# gitleaks:allow`
- **THEN** the checkpoint still stops

#### Scenario: Project allow list
- **WHEN** the project has a `.gitleaks.toml` whose allow list matches the token and a `.gitleaksignore` with its fingerprint
- **THEN** the checkpoint still stops

### Requirement: A failed scan stops the checkpoint
If gitleaks cannot be started, exits with a code other than 0 or 42, or writes a report that cannot be read, relay SHALL save nothing and exit with code 1.

#### Scenario: Scanner crashes
- **WHEN** gitleaks exits with code 1 and the error "failed to load config"
- **THEN** relay prints "The secret scan did not finish: failed to load config. Nothing was saved." and exits with code 1

#### Scenario: Scanner removed after init
- **WHEN** gitleaks is no longer installed and the person runs `relay checkpoint`
- **THEN** relay prints "relay needs gitleaks 8.28 or newer to check checkpoints for secrets. Install it with: brew install gitleaks" and exits with code 3

### Requirement: Untracked files with secret-like names need approval
An untracked, non-ignored file whose name matches the patterns in design.md decision 7 (for example `.env.local`, `id_rsa`, `server.pem`) SHALL stop the checkpoint with exit code 4 unless the person approved its path with `--include`. Approved paths SHALL be stored in `approved_paths` in `state.json` and still be scanned.

#### Scenario: Unignored .env.local
- **WHEN** `.env.local` is untracked, not ignored, and the person runs `relay checkpoint`
- **THEN** relay prints:
  ```
  Stopped: .env.local is not ignored by git and may hold secrets.
  Add it to .gitignore, or include it with: relay checkpoint --include .env.local
  ```
- **AND** exits with code 4 and appends a `checkpoint_refused` event with reason `secret_like_file` and `files` `[".env.local"]`

#### Scenario: Approved once
- **WHEN** the person runs `relay checkpoint --include .env.local` and the file contains no finding
- **THEN** the checkpoint is saved with `.env.local`, `state.json` lists `.env.local` in `approved_paths`, and later checkpoints include it without `--include`

#### Scenario: Example files allowed
- **WHEN** `.env.example` is untracked and not ignored
- **THEN** it does not need approval, and its content is still scanned
