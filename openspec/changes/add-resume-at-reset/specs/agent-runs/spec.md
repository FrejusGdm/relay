# Spec Delta: agent-runs

## Purpose

`relay run` gains the options that arm resume at reset, and a failure reason for a stop that no
reset ends.

## ADDED Requirements

### Requirement: Resume at reset options
`relay run` SHALL accept `--resume-at-reset` and `--max-resumes <n>`, which the `resume-at-reset`
capability describes. The usage line SHALL show them.

#### Scenario: Help
- **WHEN** the person runs `relay run --help`
- **THEN** the help lists `--resume-at-reset` and `--max-resumes <n>`

### Requirement: Credits required
The Claude Code adapter SHALL report the failure reason `credits_required` when a rejected
`rate_limit_event` has `errorCode` `credits_required`. A headless run that stops with it SHALL exit
with code 23 and print `Claude Code stopped: this account has used its included usage and needs
usage credits to continue.`

#### Scenario: Credits required without resume at reset
- **WHEN** a headless run stops with `credits_required`
- **THEN** relay exits with code 23 and the `turn_failed` event has `reason` `credits_required`
