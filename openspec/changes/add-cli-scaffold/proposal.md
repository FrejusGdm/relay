# Proposal

## Why

Every later phase of relay (checkpoints, adapters, `relay switch`, the daemon) needs the same base: one project, one `relay` command, one place for settings and logs, and a test and release setup that never calls a real provider. Building that base first, as phase 1 of `docs/ROADMAP.md`, lets each later change add one command without re-deciding how the program is laid out, configured, logged, tested or shipped.

## What Changes

- Create one TypeScript project on Bun with Bun's official generator, `bun init --yes`, run in the repository root with `BUN_AGENT_RULE_DISABLED=1` so it adds no agent rule files. Pin Bun 1.4.2, TypeScript 7.0.2 and `@types/bun` 1.4.2. The project has no runtime dependencies. Source: `docs/research/architecture.md` section 1; `openspec/config.yaml` ("Use official generators and CLIs").
- Add the repository layout `src/cli`, `src/core`, `src/platform`, `src/adapters`, `src/daemon`, `src/git` and `test/`.
- Add the `relay` command with a command router and help text for the sixteen first-version commands: `init`, `run`, `checkpoint`, `checkpoints`, `rollback`, `accept-git-changes`, `switch`, `status`, `account`, `providers`, `policy`, `hooks`, `hook`, `statusline`, `daemon` and `doctor`. Each later change that builds a command is named in design.md decision 3, and `docs/first-version-index.md` lists them all. In this change every command prints its help and checks its arguments. Run for real, each command reads the settings and then says plainly that it is not built yet. `relay hook` is the one exception: it stays silent and exits 0, because agents call it. Source: `VISION.md` ("The first version"); `docs/research/architecture.md` sections 6 to 8.
- Add exit-code conventions shared by all commands: 0 success, 1 failure, 2 usage error, 69 not available yet, 70 internal error, 78 settings error, 130 and 143 for interruption. Codes 3 to 63 are left for later changes, which have already claimed 3 to 8 (`add-checkpoint-engine`), 10 (`add-daemon-api-and-status`), 20 to 25 (`add-provider-adapters`) and 31 to 33 (`add-relay-switch`). The codes 64 to 78 follow the BSD `sysexits.h` convention.
- Add `RELAY_HOME`, which defaults to `~/.relay`, and loading of `RELAY_HOME/config.toml`. The settings file has a documented schema. It holds **accounts**, written as `provider:name` (for example `claude:personal`). Each account is an execution target with its own profile directory. The file also holds one **allow list** per project and a few **defaults**. relay rejects unknown keys, any key that looks like a credential, and a settings file that other users can change. Source: `docs/research/architecture.md` section 8; `docs/research/security.md` sections 2 and 6.
- Add structured logging. relay writes one JSON object per line to `RELAY_HOME/logs/cli.log` (and `logs/hook.log` for `relay hook`), with files created with mode 0600. The log rotates at 10 MB and keeps 5 older files. It never records environment variables or argument values. Source: `docs/research/architecture.md` section 8; `docs/research/security.md` section 3, recommendation 1.
- Add release builds made with `bun build --compile` for macOS arm64 and Linux x64. Automatic loading of `.env` and `bunfig.toml` is switched off inside the binaries. Source: `docs/research/architecture.md` sections 1 and 8.
- Set up the test runner (`bun test`). A preload script gives every test its own `RELAY_HOME` and `HOME`, removes credential variables from the environment, and puts guard programs named `claude` and `codex` first on `PATH`. A fake-provider fixture folder holds a scripted fake agent for later phases. Source: `docs/research/architecture.md` section 9; `openspec/config.yaml` ("Tests never call real providers").
- Add CI on GitHub Actions, with every action pinned to a full commit SHA. CI runs the type check, the tests on Linux and macOS, both builds with a smoke test, `bun audit`, and a gitleaks secret scan of the full history. Dependabot keeps the pins current. Source: `docs/research/security.md` section 8, recommendation 6.
- Add three documents: `docs/cli.md` (commands, exit codes, output and logs), `docs/config.md` with `docs/config.example.toml` (the settings schema), and `docs/development.md` (how to install, test and build).

## Capabilities

### New Capabilities

- `cli-commands`: the `relay` command line. It covers the router, help and version output, argument checking, the "not built yet" behaviour, standard output and standard error, and the exit-code table.
- `relay-config`: `RELAY_HOME`, the `config.toml` schema (accounts, project allow lists, defaults and the log level), validation, ownership and permission checks, and the error messages.
- `relay-logging`: the JSON-lines log files under `RELAY_HOME/logs`, their fields, levels, rotation and file modes, and what relay must never write to them.
- `build-and-ci`: the compiled binaries, the test isolation guarantees, and the checks that every change must pass in CI.

### Modified Capabilities

None. No specs exist yet in `openspec/specs/`.

## Decisions pending Josué's decision

Approving this proposal approves the recommendations below. Each one is listed in `docs/ROADMAP.md` under "Decisions waiting for Josué".

1. **Runtime for the daemon and CLI. Pending Josué's decision.** Recommendation: TypeScript on Bun, compiled to one binary with `bun build --compile`. In this change, Bun-only calls (here only `Bun.TOML.parse`) sit in the `src/platform/` folder (only `src/platform/toml.ts`). Later changes may call Bun APIs such as `Bun.spawn` directly where their designs say so, so a later move to Node would touch more than that folder. Go is the runner-up. Source: `docs/research/architecture.md` section 1 ("Recommendation: TypeScript on Bun").
2. **Local API transport. Pending Josué's decision.** Recommendation: a Unix socket only. Because of this, `config.toml` has no port or token setting, unlike the example in `architecture.md` section 8. Source: `docs/research/security.md` section 1 ("Recommendation").
3. **Automatic switching between two accounts of the same provider. Pending Josué's decision.** Recommendation: manual only. The schema has no automatic-switching setting in this change. Source: `docs/research/security.md` section 7.
4. **Default provider allow list. Pending Josué's decision.** Recommendation: a project allows only the account it started on. This change only stores and checks allow lists. Filling them in is done by `relay init` and `relay switch` in later phases. Source: `docs/research/security.md` section 6, recommendations 1 to 3.
5. **License. Pending Josué's decision.** Recommendation: Apache 2.0. This change adds no `LICENSE` file and marks `package.json` as `"private": true` until Josué decides. Source: `docs/ROADMAP.md`.

## Out of scope

- Any real behaviour of the sixteen commands beyond help, argument checks and loading the settings. Those behaviours come in phases 2 to 5.
- Creating profile directories, signing in to accounts, starting any agent, and checking that a project path exists.
- Any git command, the `.relay/` folder, the daemon, the socket and SQLite.
- Signing with a Developer ID, notarization, GitHub Releases, artifact attestations, the Homebrew tap and the install script. These need the Apple Developer Program and the license decision, and belong to the public release.
- Telemetry. relay has none.

## Security

This change touches credentials only by refusing them, and it adds the CI supply chain.

- `config.toml` never holds a credential. A key named like `token`, `api_key`, `password`, `secret`, `cookie` or `credentials` anywhere in the file stops relay with exit 78 and tells the person to sign in with the provider's own login command. An account may list only the *names* of credential variables it is allowed to receive (`credential_env`). Source: `docs/research/security.md` section 2, "The rule" and "Clean the environment".
- Settings live only under `RELAY_HOME`, outside any repository, so a repository cannot add itself to an allow list. relay refuses a `RELAY_HOME` or `config.toml` that another user owns or that the group or others can write. Source: `docs/research/security.md` section 6, recommendation 1, and section 1, recommendation 1 (the same ownership rule applied to the settings).
- Logs never contain environment variables, argument values or settings values. A test plants a fake API key in the environment and checks that no log file contains it. Source: `docs/research/security.md` section 3, recommendation 1.
- The binaries do not load `.env` or `bunfig.toml` from the folder they run in. Development runs use `bun --no-env-file`, and `bunfig.toml` sets `env = false`. relay runs inside other people's projects, and a project's `.env` must never enter relay's environment. Source: Bun documentation, "Automatic config loading" (https://bun.com/docs/bundler/executables), checked 2026-10-07.
- CI works as follows. Every action is pinned to a full commit SHA. The workflow token is read-only and checkout does not keep it. The lockfile is frozen. Bun's default blocking of dependency install scripts is kept. gitleaks 8.30.1 is downloaded and checked against its published SHA-256 before it runs. Source: `docs/research/security.md` section 8, recommendations 4 and 6.

## Impact

- New files: `package.json`, `bun.lock`, `tsconfig.json`, `bunfig.toml`, `src/**`, `test/**`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `docs/cli.md`, `docs/config.md`, `docs/config.example.toml` and `docs/development.md`. `.gitignore` gains `dist/`. `README.md` gains a short "Development" pointer.
- Files created on a person's machine: `RELAY_HOME` (mode 0700), `RELAY_HOME/logs/` (0700) and log files (0600). In this change relay only reads `config.toml`. Later changes write it through one module (`src/core/config/edit.ts`, `add-provider-adapters`), only to add or remove relay's own settings (accounts and allow-list entries), and never write a provider credential to it.
- Later changes build on this one. They add their command handlers under `src/cli/commands/`, their exit codes in the range 3 to 63, and their settings to the schema module and `docs/config.md`. All five later first-version changes assume this layout; `docs/first-version-index.md` maps commands, exit codes and modules to the change that owns them.
- Build and test commands run on the Omarchy machine, not on the Mac, which has little free disk (`AGENTS.md`).
