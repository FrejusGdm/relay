# Spec Delta: t3-connection

## Purpose

A person must be able to connect relay to T3 Code before relay can continue T3 threads.

## ADDED Requirements

### Requirement: Connect and disconnect commands
`relay t3 connect` SHALL require a terminal (exit code 7 otherwise), sign in with the existing
loopback sign-in to `t3.url`, keep the token only in the operating system's credential store, then
list T3's provider instances with the `[t3.instances.<id>]` table to add for each, and exit with 0.
It SHALL exit with 40 when T3 does not answer, 41 when the T3 build is too old, and 42 when T3
refuses the sign-in. `relay t3 disconnect` SHALL remove the token and the connection record and
print `relay is no longer connected to T3 Code.`

#### Scenario: Connect
- **WHEN** the person runs `relay t3 connect` at a terminal and enters the pairing code in T3
- **THEN** relay prints `Connected to T3 Code.` and, for an instance `claude`, the line `[t3.instances.claude] account = "<your claude account>"`

#### Scenario: No terminal
- **WHEN** `relay t3 connect` runs without a terminal
- **THEN** relay exits with code 7 and opens no browser
