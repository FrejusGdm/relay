# src/git

The only code that starts git. `run.ts` is the safe git runner, `repo.ts` finds the repository
that holds a folder, and `trust.ts` records the git settings and hooks when a job starts and
reports what changed since. `docs/git-safety.md` explains the rules the runner enforces and what
the trust record covers.
