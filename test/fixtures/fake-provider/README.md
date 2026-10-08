# Fake provider

Tests never start the real Claude Code or Codex. This folder holds what they use instead.

## Guard programs

`guard-bin/claude` and `guard-bin/codex` are shell scripts. The test preload (`test/setup.ts`)
puts `guard-bin/` first on `PATH`, so a test that starts `claude` or `codex` by mistake reaches
one of them. Each prints `Tests must not start the real <name>. Use test/fixtures/fake-provider
instead.` to standard error and exits with code 97.

`guard-bin/git` stops every git process that does not come from relay's git runner. It exits with
code 97 and a message unless `RELAY_GIT_RUNNER=1` is set. `src/git/run.ts` sets that variable for
the git processes it starts, and the test helpers that build scratch repositories set it
themselves. The evaluation harness's git runner, `eval/handoff/src/git.ts`, sets it too, because
the harness's tests run under the same preload. With the variable set, the guard runs the real
git, the next one on `PATH`.

The preload changes `process.env`, but `Bun.spawn`, `Bun.spawnSync` and `Bun.which` use the
environment Bun started with unless they are given one (checked with Bun 1.4.2). The preload
therefore wraps these three functions so that, without an `env` option (or a `PATH` option for
`Bun.which`), they use the current `process.env`. A child started by a test sees the test `HOME`,
no credential variables, and the guard programs first on `PATH`.

## Fake agent

`fake-agent.ts` is a small program that follows a scenario file:

```sh
bun test/fixtures/fake-provider/fake-agent.ts test/fixtures/fake-provider/scenarios/finish-ok.json
```

A scenario is a JSON object with a `description` and a list of `steps`. The steps run in order.
Each step is one of these:

| Step | What the fake agent does |
|---|---|
| `{ "stdout": "text" }` | Prints the text and a newline to standard output |
| `{ "stderr": "text" }` | Prints the text and a newline to standard error |
| `{ "sleep_ms": 200 }` | Waits that many milliseconds |
| `{ "exit": 1 }` | Exits with that code at once |

Without an `exit` step, the fake agent exits with code 0 after the last step. Any other step
makes it print `fake agent: unknown step` to standard error and exit with code 2.

When the variable `FAKE_AGENT_RECORD` names a file, the fake agent first writes a JSON record
there: `argv` (its arguments), `cwd` (its working folder) and `env_names` (the names of its
environment variables, sorted). The record never holds the values of the variables.

## Scenarios

| File | What it does |
|---|---|
| `scenarios/finish-ok.json` | Prints `working` and `done`, then exits 0 |
| `scenarios/crash.json` | Prints `fake agent crashed` to standard error, then exits 1 |
| `scenarios/slow.json` | Waits 200 milliseconds, then exits 0 |

The change `add-provider-adapters` adds `test/fakes/fake-claude.ts` and `test/fakes/fake-codex.ts`,
which speak the real programs' output formats. This simple fake agent stays for tests that only
need a scripted child process.
