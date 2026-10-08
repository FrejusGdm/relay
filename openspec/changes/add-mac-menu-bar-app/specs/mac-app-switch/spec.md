# Spec Delta

## Purpose

The Mac app offers one action: switching a job to another account. It goes through the same switch
endpoint and engine as `relay switch`, and it shows the engine's questions in the engine's own
words, so the app never asks less than the command line does.

## ADDED Requirements

### Requirement: Choosing the next account
"Switch worker…" SHALL open a sheet that lists every account with `configured` true except the current worker's account, with its target, provider name and availability words, and SHALL enable the button "Switch to <target>" only after the person selects an account.

#### Scenario: Current account not offered
- **WHEN** the current worker runs on `claude:work` and the configured accounts are `claude:work`, `claude:home` and `codex:personal`
- **THEN** the sheet lists `claude:home` and `codex:personal` only

### Requirement: The switch request
Pressing "Switch to <target>" SHALL send exactly one `POST /v1/jobs/{job}/switch` with the body `{"target":"<target>","confirm_new_provider":false}`. A `200` response SHALL close the sheet. The app SHALL NOT retry the request, and a connection that closes or a 15-minute timeout SHALL show "relay did not answer. The switch may still be running; this card updates when relay reports it."

#### Scenario: Successful switch
- **WHEN** the fake daemon answers `200` with a running worker on `codex:personal`
- **THEN** the sheet closes, the card's current worker is Codex, and the fake daemon recorded one `POST`

#### Scenario: No answer
- **WHEN** the fake daemon closes the connection without answering
- **THEN** the sheet shows the "relay did not answer" text and no second `POST` is recorded

### Requirement: New provider confirmation
When the first answer is `409` with code `confirmation_required`, the sheet SHALL show the response's message word for word with "Cancel" and "Send and switch", and only "Send and switch" SHALL send the request again with `"confirm_new_provider": true`.

#### Scenario: Confirmed
- **WHEN** the first answer is `409 confirmation_required` with the message "This sends the repository and the job notes to OpenAI through the account codex:personal. Continue?" and the person presses "Send and switch"
- **THEN** the second recorded request body has `"confirm_new_provider":true`

#### Scenario: Cancelled
- **WHEN** the person presses "Cancel" on that question
- **THEN** no second request is sent

### Requirement: Questions the API cannot answer
When an answer is `409 interactive_start_required`, or `409 confirmation_required` after the app already sent `"confirm_new_provider": true`, the sheet SHALL show the response's message word for word, then "Run this in a terminal:" and the command `cd '<project_root>' && relay switch <target>`, with "Copy command" and "Close", and SHALL send nothing more.

#### Scenario: Job runs in a terminal
- **WHEN** the answer is `409 interactive_start_required` for a project at `/Users/josue/projects/app`
- **THEN** the sheet shows the API message and the command `cd '/Users/josue/projects/app' && relay switch codex:personal`

#### Scenario: Quote in the path
- **WHEN** the project root is `/Users/josue/it's here`
- **THEN** the command is `cd '/Users/josue/it'\''s here' && relay switch codex:personal`

### Requirement: Other errors
Any other error answer SHALL show the response's message word for word with "Close".

#### Scenario: Operation in progress
- **WHEN** the answer is `409 operation_in_progress` with "Job 3f9a2c1d is already being checkpointed."
- **THEN** the sheet shows that sentence and "Close"
