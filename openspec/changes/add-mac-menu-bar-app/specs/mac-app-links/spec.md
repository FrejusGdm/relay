# Spec Delta

## Purpose

A job has one address, `relay://job/<id>`, that any tool can open. Because any web page can open a
custom link, these links only show a job in the Mac app and never start, switch, approve or roll
back anything.

## ADDED Requirements

### Requirement: Link format
The app SHALL register the `relay` URL scheme and SHALL accept a link only when its host is `job`, its path is `/` followed by exactly 8 characters from `0-9a-f`, and it has no user, password, port, query or fragment. Every other link SHALL be ignored without a message and without a request to the daemon.

#### Scenario: Valid link
- **WHEN** the app receives `relay://job/3f9a2c1d`
- **THEN** it accepts job ID `3f9a2c1d`

#### Scenario: Link with a query
- **WHEN** the app receives `relay://job/3f9a2c1d?switch=codex:personal`
- **THEN** it ignores the link and sends no request

#### Scenario: Other host
- **WHEN** the app receives `relay://switch/codex:personal`
- **THEN** it ignores the link and sends no request

### Requirement: Links only open views
An accepted link SHALL open a window showing the expanded card of that job, or bring forward the window already open for it, and SHALL NOT send any `POST` request.

#### Scenario: Opening a link
- **WHEN** the app receives `relay://job/3f9a2c1d` twice
- **THEN** exactly one window for job `3f9a2c1d` is open and the fake daemon recorded only `GET` requests

#### Scenario: Unknown job
- **WHEN** the app receives `relay://job/ffffffff` and the daemon answers `404 job_not_found`
- **THEN** the window shows "No job with id ffffffff."
