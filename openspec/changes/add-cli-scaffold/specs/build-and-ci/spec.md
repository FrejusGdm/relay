# Spec Delta

## Purpose

Defines how relay is built into standalone programs, how its tests are kept away from real providers and from the person's real files, and which checks every change must pass in continuous integration (CI) before it is merged.

## ADDED Requirements

### Requirement: Standalone binaries
The project SHALL build one standalone `relay` program for macOS on Apple silicon (`dist/relay-darwin-arm64`) and one for Linux on x64 (`dist/relay-linux-x64`). Each SHALL run on its platform without Bun or Node installed and SHALL behave like `relay` run from source.

#### Scenario: Linux build
- **WHEN** the developer runs `bun run build:linux-x64` on a Linux x64 machine
- **THEN** `dist/relay-linux-x64 --version` prints `relay 0.1.0`
- **AND** `dist/relay-linux-x64 --help` prints the top-level help

#### Scenario: macOS build
- **WHEN** the developer runs `bun run build:darwin-arm64` on a Mac with Apple silicon
- **THEN** `dist/relay-darwin-arm64 --version` prints `relay 0.1.0`

### Requirement: No loading of project files at startup
Neither the binaries nor relay run from source through the package scripts SHALL load a `.env` file or a `bunfig.toml` file from the folder where relay runs.

#### Scenario: A project with a .env file
- **WHEN** the current folder has a `.env` file containing `RELAY_LOG_LEVEL=loud` and the person runs `dist/relay-linux-x64 status` there with a valid relay folder
- **THEN** relay exits with code 69, not 78, because it never read that `.env` file

### Requirement: Tests are isolated
Every test run SHALL give tests a new temporary relay folder and home folder. It SHALL remove credential variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_HOME`, `CURSOR_API_KEY`) from the environment. It SHALL put guard programs named `claude` and `codex` first on `PATH`.

#### Scenario: A test starts the real tool by mistake
- **WHEN** a test runs `claude --version`
- **THEN** the guard program prints `Tests must not start the real claude. Use test/fixtures/fake-provider instead.` to standard error and exits with code 97

#### Scenario: The person's own relay folder
- **WHEN** the test suite runs on a machine where `~/.relay/config.toml` exists
- **THEN** no test reads or changes that file

### Requirement: Fake provider fixture
The repository SHALL include a fake agent program in `test/fixtures/fake-provider/` that follows a scenario file. A scenario is a list of steps: print a line to standard output, print a line to standard error, wait a number of milliseconds, or exit with a code. When asked, the fake agent SHALL record its arguments, working folder and the names (never the values) of its environment variables to a JSON file.

#### Scenario: Scripted run
- **WHEN** the fake agent runs the scenario `finish-ok.json`
- **THEN** its standard output is the scenario's lines in order and it exits with code 0

#### Scenario: Recording without values
- **WHEN** the fake agent runs with `FAKE_AGENT_RECORD` set to a file path and `SOME_TOKEN=abc` in its environment
- **THEN** the record lists `SOME_TOKEN` among the variable names and does not contain `abc`

### Requirement: Checks on every change
CI SHALL run on every push to `main` and every pull request. It SHALL install dependencies from the lockfile without changing it, type-check the code, run the tests on Linux x64 and macOS arm64, build both binaries and run each one's `--version` and `--help`, run `bun audit`, and scan the full git history for secrets. Any failing step SHALL fail the run.

#### Scenario: A failing test
- **WHEN** a pull request makes one test fail
- **THEN** the CI run for that pull request fails

#### Scenario: A committed secret
- **WHEN** a pull request adds a file containing a private key block
- **THEN** the secret scan step fails and the CI run fails

### Requirement: Pinned and least-privilege CI
Every action a workflow uses SHALL be pinned to a full 40-character commit SHA, followed by a comment naming its version, and CI SHALL fail when one is not. Workflows SHALL grant the token only `contents: read`, and checkout SHALL NOT keep the token in the git configuration. The secret scanner SHALL be a fixed version whose download is checked against its published SHA-256 checksum before it runs.

#### Scenario: Unpinned action
- **WHEN** a pull request changes a workflow line to `uses: actions/checkout@v7`
- **THEN** the pin check step prints that line and the CI run fails

### Requirement: No network use and no telemetry
relay SHALL NOT open network connections or send usage data in this version. The only connections relay ever opens are to its own Unix socket, which `add-daemon-api-and-status` adds, through one client folder, `src/client/`, and, since `add-t3-limit-rules` (approved 2026-10-08), to T3 Code on this computer: `src/t3/client.ts` may call `fetch`, and `src/t3/oauth.ts` may call `fetch` and `Bun.serve` for the short sign-in listener on `127.0.0.1`.

#### Scenario: Source check
- **WHEN** the source under `src/` is searched for the word `fetch` (which also finds `globalThis.fetch`), the module names `net`, `http`, `https`, `http2`, `dgram` and `tls` with or without the `node:` prefix, `Bun.connect`, `Bun.listen`, `Bun.serve`, `Bun.udpSocket`, `XMLHttpRequest`, `EventSource` and `WebSocket`
- **THEN** there are no matches outside `src/client/`, except `fetch` in `src/t3/client.ts` and `fetch` and `Bun.serve` in `src/t3/oauth.ts`
- **AND** the only matches inside `src/client/` are calls to `fetch` and `Bun.connect` that pass an object with a `unix:` key directly as an argument
