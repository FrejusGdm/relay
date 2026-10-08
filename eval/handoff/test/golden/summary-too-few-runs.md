# Handoff evaluation: too-few-runs

Plan: standard. Campaign: too-few-runs. Runs complete: 9.
Tools at the start: relay 0.1.0, claude 2.1.282, codex 0.160.0, bun 1.3.6, git 2.39.0, python3 3.11.3.

## Verdicts

- Claude to Codex: not enough runs yet (4 of 9).

## Outcomes

| Task | Kind | Direction | Point | Runs | Solved | Acceptance passed | Median minutes | Median next-agent minutes | Rework | Regressions | False claims found | verify.md written | Failed handoffs | First-agent output tokens | Next-agent output tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ledger-import | baseline | claude:personal | — | 3 | 3 of 3 | 100% | 30.0 | — | 0.05 | 0 of 3 | — | — | — | 900 | — |
| ledger-import | baseline | codex:personal | — | 1 | 1 of 1 | 100% | 40.0 | — | 0.10 | 0 of 1 | — | — | — | not reported | — |
| ledger-import | handoff | claude:personal to codex:personal | steps:25 | 2 | 2 of 2 | 100% | 40.0 | 24.0 | 0.08 | 0 of 2 | 0 | 2 of 2 | 0 of 2 | 400 | not reported |
| ledger-import | handoff | claude:personal to codex:personal | steps:50 | 1 | 1 of 1 | 100% | 41.0 | 20.0 | 0.08 | 0 of 1 | 0 | 1 of 1 | 0 of 1 | 400 | not reported |
| ledger-import | handoff | claude:personal to codex:personal | steps:75 | 1 | 1 of 1 | 100% | 40.0 | 14.0 | 0.08 | 0 of 1 | 0 | 1 of 1 | 0 of 1 | 400 | not reported |

## Runs that need a look

- [ledger-import__handoff__claude-to-codex__steps-50__r2](runs/ledger-import__handoff__claude-to-codex__steps-50__r2/): status contaminated.
