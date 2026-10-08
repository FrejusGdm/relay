# Design

## Context

The repository holds only documents today. See proposal.md ("Why") for the motivation. The constraints that shape this design:

- The runtime recommendation is TypeScript on Bun, compiled to one binary (`docs/research/architecture.md` section 1). This is pending Josué's decision. Approving the proposal approves it.
- Settings, logs and future live state live under `~/.relay`, which `RELAY_HOME` can override (`architecture.md` section 8).
- The Mac has little free disk. Installing, building and testing happen on the Omarchy machine (`AGENTS.md`, `jstack-remote-build` skill).
- Five sibling proposals build on this scaffold. `add-checkpoint-engine` adds `src/cli/commands/<name>.ts` handlers, `src/cli/output.ts` and `src/git/`, and uses exit codes 3 to 8. `add-provider-adapters` adds `src/adapters/`, `src/accounts/` and the only writer of `config.toml`, and uses exit codes 20 to 25. `add-relay-switch` adds `src/handoff/` and exit codes 31 to 33. `add-daemon-api-and-status` adds exit code 10 and writes `logs/daemon.log` in this same JSON-lines format, rotated at 10 MB with 5 older files kept; `logs/hook.log` keeps the rotation of decision 8. `docs/first-version-index.md` lists every command, exit code, event type, job file and module of the first version.

Facts checked on 2026-10-07:

- The latest Bun release is 1.4.2 (5 September 2026). `bun init --yes` writes `package.json`, `tsconfig.json` and an `index.ts` entry. It keeps any existing `README.md` and `.gitignore`, adds `typescript` `^7` as a peer dependency and `@types/bun` as a development dependency, and runs `bun install`. It writes `CLAUDE.md` and Cursor rule files unless `BUN_AGENT_RULE_DISABLED=1` is set. Sources: https://bun.com/docs/runtime/templating/init, and `src/runtime/cli/init_command.rs` at tag `bun-v1.4.2`.
- The `tsconfig.json` that Bun 1.4.2 generates already has `"types": ["bun"]`, `"strict": true`, `"noEmit": true`, `"moduleResolution": "bundler"` and `"noUncheckedIndexedAccess": true`. TypeScript 7.0.2 is the latest release, and its package provides the `tsc` program.
- The `bun check` type checker described on bun.com was merged into Bun's main branch on 6 October 2026, but it is not in any release yet. This change therefore uses `tsc --noEmit`. When a Bun release includes `bun check`, the `typecheck` script can switch to it.
- `Bun.TOML.parse` implements TOML 1.1 and throws `SyntaxError` on invalid input (https://bun.com/docs/runtime/toml).
- `bun build --compile` supports `--target=bun-darwin-arm64` and `--target=bun-linux-x64`. The flags `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig` stop a compiled program from loading `.env` and `bunfig.toml` from its working folder, which it does by default (https://bun.com/docs/bundler/executables, "Automatic config loading").
- Pinned actions: `actions/checkout` v7.0.1 is `3d3c42e5aac5ba805825da76410c181273ba90b1`. `oven-sh/setup-bun` v2.2.0 is `0c5077e51419868618aeaa5fe8019c62421857d6` and accepts `bun-version-file: package.json`. `actions/upload-artifact` v7.0.2 is `cf430e030ddbb5b0abf93d22962f4752f3646cd9`. gitleaks 8.30.1 for linux_x64 has SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`. Runner labels: `ubuntu-24.04` (x64) and `macos-26` (arm64). Dependabot supports the `bun` ecosystem with `bun.lock`.

## Goals / Non-Goals

**Goals:**

- One way to add a command, an exit code, a setting and a log event, so that later changes only add entries.
- Every user-visible text is fixed here or in golden files, so tests can compare it exactly.
- Everything Bun-specific in this change sits in the `src/platform/` folder (here only `src/platform/toml.ts`), the package scripts and the build flags. This rule applies to this change only. Later changes put their own platform modules in the same folder (`src/platform/clock.ts`, `src/platform/libc.ts`, `src/platform/file-lock.ts`), and they may also call Bun APIs such as `Bun.spawn`, `Bun.which` and `Bun.listen` directly in other folders where their designs say so.
- Fast tests that run in the same process, plus a few tests that start a real process for signals, standard input and `.env` handling.

**Non-Goals:**

- Colour output, a progress display, shell completion, or "did you mean" suggestions.
- Windows. The ownership checks use POSIX user IDs.
- Checking that profile folders or project paths exist. That belongs to the commands that use them.

## Decisions

### 1. Creating the project with `bun init`

Source: `openspec/config.yaml` ("Use official generators and CLIs"), `architecture.md` section 1.

On the Omarchy machine, in the repository root:

```sh
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"   # only if `bun --version` is not 1.4.2
BUN_AGENT_RULE_DISABLED=1 bun init --yes
rm index.ts
bun add --dev --exact typescript@7.0.2 @types/bun@1.4.2
```

Then edit `package.json` to exactly this content and run `bun install` again to update `bun.lock`:

```json
{
  "name": "relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "module": "src/cli/main.ts",
  "bin": { "relay": "./src/cli/main.ts" },
  "packageManager": "bun@1.4.2",
  "scripts": {
    "relay": "bun --no-env-file src/cli/main.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "build:darwin-arm64": "bun build ./src/cli/main.ts --compile --target=bun-darwin-arm64 --minify --sourcemap --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile=dist/relay-darwin-arm64",
    "build:linux-x64": "bun build ./src/cli/main.ts --compile --target=bun-linux-x64 --minify --sourcemap --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile=dist/relay-linux-x64"
  },
  "devDependencies": {
    "@types/bun": "1.4.2",
    "typescript": "7.0.2"
  }
}
```

The `peerDependencies` block that `bun init` wrote is removed, because `typescript` is now an exact development dependency. In the generated `tsconfig.json`, add `"resolveJsonModule": true` so that `src/core/version.ts` can import `package.json`. Add `dist/` to the existing `.gitignore`.

Add `bunfig.toml`:

```toml
env = false

[test]
root = "test"
preload = ["./test/setup.ts"]
```

`env = false` stops Bun from loading `.env` files for `bun run` and `bun test` in this repository. The `relay` script also passes `--no-env-file`, and the entry file's first line is `#!/usr/bin/env -S bun --no-env-file`, because relay is meant to run inside other people's projects.

Alternatives considered: hand-writing `package.json` (rejected by the project rules); the `bun check` type checker (not released yet); a runtime dependency for argument parsing or schema checks such as `commander` or `zod` (rejected: `node:util` `parseArgs` and a small hand-written checker are enough, and `security.md` section 8 asks for few dependencies).

### 2. Repository layout

```
src/cli/main.ts               entry: shebang, signal handlers, runCli, process.exit
src/cli/run.ts                runCli(ctx): the whole flow in decision 4
src/cli/router.ts             route(argv, commands): RouteResult
src/cli/help.ts               renderTopHelp(commands), renderCommandHelp(def)
src/cli/io.ts                 Io interface and processIo()
src/cli/exit-codes.ts         the ExitCode table (decision 5)
src/cli/errors.ts             UsageError, SettingsError
src/cli/commands/registry.ts  the sixteen CommandDef entries (decision 3)
src/cli/commands/not-built.ts the shared "not built yet" handler
src/cli/commands/hook.ts      the silent hook handler for this phase
src/platform/toml.ts          parseToml(): in this change, the only file that uses the Bun global
src/core/version.ts           VERSION, read from package.json at build time
src/core/paths.ts             resolveRelayHome(), expandPath()
src/core/relay-home.ts        ensureRelayHome(), readPrivateFile()
src/core/config/types.ts      RelayConfig, Account, Project, LogLevel
src/core/config/load.ts       loadConfig()
src/core/config/validate.ts   validateConfig()
src/core/config/log-level.ts  resolveLogLevel()
src/core/log.ts               openLog(), Logger, rotation
src/adapters/providers.ts     PROVIDERS = ["claude", "codex"] as const; type Provider
src/daemon/README.md          one paragraph: filled by add-daemon-api-and-status
src/git/README.md             one paragraph: filled by add-checkpoint-engine
scripts/smoke-test.sh         runs a built binary (decision 10)
test/setup.ts                 test preload (decision 9)
test/helpers/cli.ts           runRelayInProcess(), runRelay() (spawned)
test/helpers/home.ts          makeRelayHome(configText?, mode?)
test/cli/golden/*.txt         exact help texts: top-help.txt and one file per command
test/fixtures/config/*.toml   settings fixtures
test/fixtures/fake-provider/  fake agent, scenarios, guard programs, README.md
```

Later changes add folders such as `src/checkpoint/`, `src/job/`, `src/accounts/`, `src/handoff/` and `src/state/` (the full map is in `docs/first-version-index.md`). They replace the not-built handler of their command with `src/cli/commands/<name>.ts` and update its entry in `registry.ts`.

### 3. The command table

Source: `VISION.md` ("The first version"), `architecture.md` sections 6 to 8, and the commands that the five later first-version changes define.

```ts
export type CommandName = "init" | "run" | "checkpoint" | "checkpoints" | "rollback"
  | "accept-git-changes" | "switch" | "status" | "account" | "providers" | "policy"
  | "hooks" | "hook" | "statusline" | "daemon" | "doctor";

export interface OptionDef {
  name: string;          // long name without dashes, for example "message"
  short?: string;        // one letter, for example "m"
  value?: string;        // placeholder when the option takes a value, for example "<text>"
  description: string;
}

export interface CommandDef {
  name: CommandName;
  usage: string;         // "relay switch <provider[:account]>"
  argsUsage: string;     // "<provider[:account]>", used in "needs ..." messages; "" when none
  summary: string;       // one line, no final period
  details: string[];     // lines printed after the summary
  examples: string[];
  options: OptionDef[];  // the command's own options
  minArgs: number;
  maxArgs: number;
  quiet: boolean;        // true only for hook: no output, always exit 0
  built: boolean;        // false for all sixteen in this change
  handler: (ctx: CommandContext) => Promise<number>;
}
```

| Command | Usage | Arguments | Own options | Built by |
|---|---|---|---|---|
| init | `relay init [--title <text>]` | 0 | `--title <text>` "A short name for the job" | `add-checkpoint-engine` |
| run | `relay run [<provider[:account]>]` | 0 to 1 | none in this change | `add-provider-adapters`, extended by `add-relay-switch` |
| checkpoint | `relay checkpoint [-m <text>]` | 0 | `-m, --message <text>` "A short summary of what changed" | `add-checkpoint-engine` |
| checkpoints | `relay checkpoints` | 0 | none in this change | `add-checkpoint-engine` |
| rollback | `relay rollback [<checkpoint>]` | 0 to 1 | none in this change | `add-checkpoint-engine` |
| accept-git-changes | `relay accept-git-changes` | 0 | none | `add-checkpoint-engine` |
| switch | `relay switch <provider[:account]>` | 1 | none in this change | `add-relay-switch` |
| status | `relay status` | 0 | none in this change | `add-daemon-api-and-status` |
| account | `relay account <list\|add\|status\|login\|remove> [<provider> <name> \| <provider:name>]` | 1 to 3 | none in this change | `add-provider-adapters` |
| providers | `relay providers` | 0 | none in this change | `add-provider-adapters` |
| policy | `relay policy show <provider>` | 2 | none | `add-provider-adapters` |
| hooks | `relay hooks <install\|remove\|status> <provider:name>` | 2 | none in this change | `add-provider-adapters` |
| hook | `relay hook <provider> <event>` | 2 | none | `add-provider-adapters` (spool), extended by `add-daemon-api-and-status` (delivery to the daemon) |
| statusline | `relay statusline <provider>` | 1 | none | `add-provider-adapters` |
| daemon | `relay daemon <start\|stop\|restart\|status\|run>` | 1 | none in this change | `add-daemon-api-and-status` |
| doctor | `relay doctor --reindex` | 0 | `--reindex` "Rebuild the index from the job files" | `add-daemon-api-and-status` |

Summaries, details and examples:

| Command | Summary | Details | Examples |
|---|---|---|---|
| init | Set up .relay/ in this project | relay creates the .relay/ folder for a job and keeps it out of your commits. | `relay init`, `relay init --title "Build authentication"` |
| run | Start an agent inside a relay job | Without an account, relay uses defaults.account from your settings. | `relay run`, `relay run claude:personal` |
| checkpoint | Save the job so another agent can continue it | relay saves your files as a commit under refs/relay/. / Your branch and staged changes stay as they are. | `relay checkpoint -m "OAuth callback works"` |
| checkpoints | List the job's checkpoints | Newest first. | `relay checkpoints` |
| rollback | Return the files to an earlier checkpoint | relay saves the current state first, so you can undo the rollback. / Without a checkpoint, relay uses the latest one. | `relay rollback`, `relay rollback 3` |
| accept-git-changes | Trust a change to git settings or hooks after you check it | Run it yourself in a terminal. It asks for your answer, so agents cannot run it. | `relay accept-git-changes` |
| switch | Hand the job to another agent or account | relay saves a checkpoint, writes the handoff and starts the next agent. | `relay switch codex:personal`, `relay switch claude:startup` |
| status | Show the job, its workers, accounts and checkpoints | (none) | `relay status` |
| account | Add, list, check, sign in to or remove accounts | Each account has its own profile folder. / Signing in runs the provider's own login. relay never sees your password or token. | `relay account list`, `relay account add codex work`, `relay account login codex:work` |
| providers | Show which agent programs are installed | (none) | `relay providers` |
| policy | Show relay's notes on a provider's terms | (none) | `relay policy show claude` |
| hooks | Add, remove or check relay's hooks for an account | Hooks let relay see when an agent stops or reaches a limit. | `relay hooks install claude:personal`, `relay hooks status codex:personal` |
| hook | Pass an event from an agent's hooks to relay | Claude Code and Codex call this command from their hooks. / You do not need to run it yourself. | `relay hook claude Stop` |
| statusline | Record usage from Claude Code's status line | Claude Code runs this command when you install relay's status line. / You do not need to run it yourself. | `relay statusline claude` |
| daemon | Start, stop or check relay's background service | The service keeps live job state and listens only on a private socket in your relay folder. / relay starts it by itself when a command needs it. | `relay daemon status` |
| doctor | Rebuild relay's index of jobs | relay rebuilds the index from the .relay/ files and git, so nothing about your jobs is lost. | `relay doctor --reindex` |

A `/` in the details column separates printed lines. These usage lines match the command lines the later changes specify, without the options this change does not accept yet. The change named in the "Built by" column owns the command's final syntax, adds its options, and updates `registry.ts`, the golden help file and `docs/cli.md` together.

### 4. The flow of one run

`runCli(ctx: CliContext): Promise<number>` with:

```ts
interface CliContext {
  argv: string[];                         // process.argv.slice(2)
  env: Record<string, string | undefined>;
  homedir: string;                        // env.HOME, or os.homedir() when HOME is unset or empty
  uid: number;                            // process.getuid()
  io: Io;                                 // { out(text), err(text), stdinIsTTY, readStdinToEnd() }
  commands?: CommandDef[];                // tests may replace the table
}
```

relay takes the home folder from `env.HOME` and falls back to `os.homedir()` only when `HOME` is unset, empty or not an absolute path (a relative `HOME` would put the relay folder inside the current folder). Bun's `os.homedir()` ignores a `HOME` that the process changed (checked with Bun 1.4.2), so a test that sets `HOME` and leaves `RELAY_HOME` unset would otherwise reach the person's real `~/.relay`. Task 4.1 adds the test for this rule.

1. `route(ctx.argv, commands)` returns one of:
   - `{ kind: "top-help" }`, for no arguments, a first argument of `-h` or `--help`, or `help` alone;
   - `{ kind: "version" }`, for a first argument of `--version`;
   - `{ kind: "command-help", def }`, for `help <command>`, or when any later argument is exactly `-h` or `--help`;
   - `{ kind: "usage-error", lines, quiet }`;
   - `{ kind: "run", def, positionals, optionNames, values, logLevelFlag }`.

   The router splits off the command name, then calls `parseArgs({ args, options, strict: true, allowPositionals: true })` from `node:util`. The options are the command's own options plus `help` (`-h`) and `log-level` (string). A `TypeError` with code `ERR_PARSE_ARGS_UNKNOWN_OPTION` becomes the "unknown option" message. `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` becomes "needs a value". The argument count and the `--log-level` value are checked after parsing.
2. Help and version print to `io.out` and return 0. A usage error prints its lines to `io.err` and returns 2. For `hook`, a usage error prints nothing, goes on to step 3 only to write a `hook usage error` entry to `hook.log` (with `arguments`, a count), and returns 0. The level of that entry comes from `RELAY_LOG_LEVEL`, then valid settings, then `info`; settings that cannot be read are ignored there and nothing is printed.
3. `resolveRelayHome(env, homedir)`, then `ensureRelayHome(path, uid)`. A failure is a `SettingsError` (exit 78), which is printed and not logged, because the folder cannot be trusted. For `hook`, nothing is printed and the result is 0.
4. `openLog({ relayHome, file: def.name === "hook" ? "hook.log" : "cli.log", level, ... })`, where `level` comes from the flag, then `RELAY_LOG_LEVEL`, then `info`. Settings are not loaded yet. An invalid `RELAY_LOG_LEVEL` is remembered as a settings error, the logger starts at `info`, and step 6 reports the error.
5. `loadConfig({ relayHome, homedir, uid })`. Then `resolveLogLevel(flag, env, config)` and `logger.setLevel(level)`. Only after this, write `command started`, then `settings loaded` or `settings invalid`. This order lets `log.level = "warn"` in the settings suppress `command started`.
6. A settings error prints its lines (except for `hook`), writes `command finished` with `exit_code` 78, and returns 78.
7. Call `def.handler(commandContext)`, write `command finished` with `exit_code` and `duration_ms`, and return the code.
8. Any exception that escapes steps 3 to 7 is logged as `unexpected error` (with `error_name` and the stack frames, never the message) and printed as `relay: unexpected error: <message>` plus `Details are in <log file>.`, and the run returns 70. The second line is left out when the log is not being written. `hook` prints nothing and returns 0.

`main.ts` installs `SIGINT` and `SIGTERM` handlers before calling `runCli`. Each handler writes `command interrupted` with the signal name to the open logger, if there is one, and exits with 130 or 143.

The not-built handler prints `relay: <name> is not built yet. This version only reads your settings and shows help.` and returns 69. The phase 1 hook handler calls `io.readStdinToEnd()` when `stdinIsTTY` is false, writes `hook ignored: not built yet` with `provider` and `event`, and returns 0. `provider` is the first argument when it is `claude` or `codex`, and `event` is the second argument when it is in that provider's list of hook events (Claude Code: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `StopFailure`, `SubagentStop`, `PreCompact`; Codex: the events `add-provider-adapters` installs, `SessionStart`, `Stop`, `SessionEnd`, `Interrupt`, `PreCompact`). Any other value is logged as `null`, so a word an agent passes by mistake, which could be a secret, never reaches the log.

### 5. Exit codes

Source: the BSD `sysexits.h` convention for 64 to 78 (FreeBSD manual page sysexits(3)) and the shell convention of 128 plus the signal number.

| Code | Constant | Meaning |
|---|---|---|
| 0 | `Ok` | The command did what was asked. |
| 1 | `Failed` | The command ran and could not finish. |
| 2 | `Usage` | The command line is wrong. |
| 3 to 63 | (reserved) | Specific outcomes added by later changes: 3 to 8 by `add-checkpoint-engine`, 10 by `add-daemon-api-and-status`, 20 to 25 by `add-provider-adapters`, 31 to 33 by `add-relay-switch`. The other numbers are free. |
| 69 | `NotAvailable` | The command exists but this version cannot do it (`EX_UNAVAILABLE`). |
| 70 | `Internal` | A bug in relay (`EX_SOFTWARE`). |
| 78 | `Settings` | The relay folder, `config.toml` or a relay environment variable is wrong (`EX_CONFIG`). |
| 130 | `Interrupted` | Stopped by SIGINT (Control-C). |
| 143 | `Terminated` | Stopped by SIGTERM. |

`src/cli/exit-codes.ts` exports `ExitCode` as a frozen object with these names. `docs/cli.md` has the same table, and `test/cli/exit-codes.test.ts` parses that table and compares it with the constants.

Alternative considered: small sequential codes (3 for settings, 4 for not available). Rejected because the checkpoint engine already uses 3 to 8 for its own outcomes. The standard 64 to 78 codes leave that range free.

### 6. Help text

The exact top-level help (`test/cli/golden/top-help.txt`):

```
relay keeps your coding work moving between agents and accounts.

Usage
  relay <command> [options]

Commands
  init                Set up .relay/ in this project
  run                 Start an agent inside a relay job
  checkpoint          Save the job so another agent can continue it
  checkpoints         List the job's checkpoints
  rollback            Return the files to an earlier checkpoint
  accept-git-changes  Trust a change to git settings or hooks after you check it
  switch              Hand the job to another agent or account
  status              Show the job, its workers, accounts and checkpoints
  account             Add, list, check, sign in to or remove accounts
  providers           Show which agent programs are installed
  policy              Show relay's notes on a provider's terms
  hooks               Add, remove or check relay's hooks for an account
  hook                Pass an event from an agent's hooks to relay
  statusline          Record usage from Claude Code's status line
  daemon              Start, stop or check relay's background service
  doctor              Rebuild relay's index of jobs

Options
  -h, --help               Show help
      --version            Show the version
      --log-level <level>  How much to log: debug, info, warn or error

Run "relay <command> --help" for details about one command.
Settings live in ~/.relay/config.toml, or in $RELAY_HOME/config.toml when RELAY_HOME is set.
```

Command rows are `"  " + name.padEnd(20) + summary` (the longest name, `accept-git-changes`, has 18 characters). Option rows are `"  " + left.padEnd(23) + "  " + description`, where `left` is `-x, --name <value>` with a short letter, or four spaces then `--name <value>` without one.

Command help follows one template. The exact text for `switch` (`test/cli/golden/switch.txt`):

```
Usage
  relay switch <provider[:account]>

Hand the job to another agent or account.
relay saves a checkpoint, writes the handoff and starts the next agent.

Examples
  relay switch codex:personal
  relay switch claude:startup

Options
  -h, --help               Show this help
      --log-level <level>  How much to log: debug, info, warn or error

Not built yet. This version only reads your settings.
```

The summary gets a final period. Detail lines follow it directly. A command with no details has no detail lines. The command's own options come before `-h, --help`. The last line appears only while `built` is false. Every output ends with exactly one newline. The other fifteen golden files are produced from the same template and the tables in decision 3. Each one is reviewed by reading it once, then committed.

The texts follow the voice in `VISION.md` ("Design direction") and the design notes. They are short and plain, they say what relay does with the person's files, and they make no promises the version cannot keep.

### 7. Settings

Source: `architecture.md` section 8 (`RELAY_HOME`, `config.toml`, profile folders per account), `security.md` section 2 (no credentials, `credential_env`), section 6 (allow list outside the repository, account kinds) and section 1 (ownership and mode checks).

Types (`src/core/config/types.ts`):

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";
export type AccountId = `${Provider}:${string}`;      // Provider from src/adapters/providers.ts

export interface Account {
  id: AccountId;               // "claude:personal"
  provider: Provider;          // "claude"
  name: string;                // "personal"
  profileDir: string;          // absolute, normalized
  profileDirIsDefault: boolean;
  credentialEnv: string[];     // names only, for example ["ANTHROPIC_API_KEY"]
  kind: "personal" | "work" | null;
}

export interface Project {
  path: string;                // absolute, normalized
  allow: AccountId[];          // in file order
}

export interface RelayConfig {
  file: string;                // <relay folder>/config.toml
  exists: boolean;
  version: 1;
  defaults: { account: AccountId | null };
  log: { level: LogLevel | null };
  accounts: Account[];         // in file order
  projects: Project[];         // in file order
}

export interface ConfigProblem { key: string; message: string }   // printed as "  <key>: <message>"
```

Why accounts use `provider:name` names: `VISION.md` calls an account an execution target, written like `claude:personal`, and `relay switch` takes the same form. The settings call the table `accounts`, because that is the word the person sees in `relay status` and the Mac card (design notes). `architecture.md` section 8 used `[targets."..."]` with a separate `provider` key. This design derives the provider from the name instead, so the two cannot disagree.

Loading (`loadConfig`):

1. `file = join(relayHome, "config.toml")`. If `lstat` fails with `ENOENT`, return the empty settings with `exists: false`. Only a missing file gives the empty settings; every other failure is a settings error.
2. `readPrivateFile(file, uid, 1_048_576)` opens the file once with `O_RDONLY | O_NONBLOCK` (following a symbolic link; `O_NONBLOCK` keeps a named pipe from blocking `open`), calls `fstat` on the descriptor, and requires a regular file, `uid` equal to the current user, `(mode & 0o022) === 0` and `size <= 1_048_576`. It then reads at most 1 MB plus one byte through the same descriptor, so the file that is checked is the file that is read, and a file that grew past the limit is refused. A failed check gives the message from the relay-config spec.
3. Decode the bytes as UTF-8 and call `parseToml(text)`. A thrown error becomes `relay: cannot read <file>: <parser message>`. Bun's parser repeats part of the file in some messages (`Strings must be quoted: "<value>"`), and that part could be a credential. relay therefore replaces every quoted piece longer than three characters with `"..."` and ends the message at a quote that is never closed. Pieces of three characters or fewer, such as `'='` or `']]'`, stay, so the message still says what is wrong.
4. Call `validateConfig(raw, { relayHome, homedir })`, which returns `{ config, problems }`. Any problem becomes the problem report.

Checking (`validateConfig`) walks the parsed object in key order and collects problems:

- Top level: allowed keys `version`, `defaults`, `log`, `accounts` and `projects`. `version` must be the integer 1. A larger integer gives the "newer relay" message, and anything else gives `must be 1.`
- `defaults`: a table. Allowed key `account`, a string naming an account defined anywhere in the file.
- `log`: a table. Allowed key `level`, one of the four levels.
- `accounts`: a table of tables. A table name failing `^[a-z]+:[a-z0-9][a-z0-9-]{0,31}$` gets the "lowercase" message. A well-formed name whose provider is not in `PROVIDERS` gets the "not supported yet" message. Allowed keys: `profile_dir` (path), `credential_env` (array of strings matching `^[A-Z_][A-Z0-9_]*$`), `kind` (`"personal"` or `"work"`).
- `projects`: an array of tables. Required keys: `path` (path) and `allow` (array of strings naming defined accounts, with no repeats: `projects[1].allow: "codex:personal" is listed twice.`).
- Paths go through `expandPath(value, homedir)`. `"~"` becomes `homedir`. A value starting with `"~/"` is joined to `homedir`. An absolute value is kept. Anything else is a problem. Each result goes through `path.resolve`.
- Profile folders are compared after normalization. The second account with a repeated folder gets the "same folder" problem. Two projects with the same path get `projects[2].path: the same path as projects[1].`
- Any key not allowed where it appears is a problem. When its lowercase name contains `token`, `apikey`, `api_key`, `password`, `secret`, `cookie` or `credential`, the message is the credential message. Otherwise it is `unknown setting.` The problem never includes the value. Known keys (`credential_env`) are matched before this check.
- Type messages: `must be a string.`, `must be a table.`, `must be a list of account names.`, `must be a list of variable names in capitals, for example "ANTHROPIC_API_KEY".`, `must be "personal" or "work".`, `must be debug, info, warn or error.`, `is required.`
- Key paths in messages quote any key with characters outside `[A-Za-z0-9_-]` (`accounts."claude:personal".kind`). `[[projects]]` entries are counted from 1 (`projects[1].path`).
- Keys come from the file, so every lookup by key uses `Object.hasOwn`. A key named `__proto__`, `constructor` or `toString` is an unknown setting like any other.
- A problem never shows a value, with one exception: an account name in `allow` or `defaults.account` is repeated only when it has the `provider:name` form. Any other text there gets the "account names look like provider:name" message.
- A key whose value is a table relay does not know is searched for credential-named keys at any depth, and each one gets the credential message.
- Known limits of Bun's parser, accepted for this version: `version = 1.0` is read as the integer 1 and accepted, and Bun lists keys that look like integers (`"1" = ...`) before the other keys of their table, so their problems come first.

Every value or path relay repeats in a message goes through one helper, `src/core/quote.ts`. `quote(value)` writes a value in double quotes the way `JSON.stringify` does, and `printable(text)` writes text without quotes. Both also write every control character (U+0000 to U+001F and U+007F to U+009F, where U+009B starts a terminal control sequence like ESC `[`), format character (such as direction marks) and line or paragraph separator as a `\u` escape, so nothing in a value or path can change what the terminal shows. The router uses the same helper.

Messages that the relay-config spec does not list:

| Situation | Message |
|---|---|
| `RELAY_HOME` resolves to the home folder itself (`~`, `~/`, `$HOME`, `$HOME/`) | `relay: RELAY_HOME cannot be your home folder itself ("~"). Use a folder of its own, such as ~/.relay.` |
| The relay folder path is not a folder | `relay: <folder> is not a folder.` |
| The owner lacks read, write or search permission on the relay folder | `relay: you cannot read, write and open <folder>. Run "chmod 700 <folder>" and try again.` |
| `config.toml` is not a regular file (a folder, a named pipe, a device) | `relay: <file> is not a regular file.` |
| `config.toml` belongs to another user | `relay: <file> belongs to another user. relay only uses a file you own.` |
| `config.toml` is larger than 1 MB | `relay: <file> is larger than 1 MB, the most relay reads.` |
| `RELAY_LOG_LEVEL` is not a level | `relay: RELAY_LOG_LEVEL must be debug, info, warn or error, not "loud".` |
| `projects` is not a list of tables | `projects: must be a list of [[projects]] tables.` |
| A file-system call fails | `relay: cannot use <path>: <reason>.` |

The reason in the last row is a plain sentence chosen by the error code, never the system's own message: `ENOENT` gives `it, or the file it links to, does not exist`, `EACCES` and `EPERM` give `you do not have permission`, `ENOTDIR` gives `part of the path is not a folder`, `ELOOP` gives `it leads through too many symbolic links`, and any other code gives `the system reported <code>`.

Every later change that adds a setting adds it to `validate.ts`, `types.ts`, `docs/config.md` and `docs/config.example.toml` in the same pull request (`[checkpoint] max_file_size_mb` from `add-checkpoint-engine`, the `[handoff]` table from `add-relay-switch`).

Writing `config.toml`: this change only reads the file. relay's settings are relay's own, so later changes may write them, but only through one module, `src/core/config/edit.ts` (`add-provider-adapters`), which appends or removes whole tables for accounts and project allow lists, keeps every other byte, and checks the result with `validateConfig` before it renames a temporary file over the original. relay never writes a provider credential to `config.toml`; the credential check above refuses one even if a person adds it by hand.

The relay folder (`src/core/relay-home.ts`): `ensureRelayHome(path, uid)` looks at the path with `lstat`. When nothing is there, it creates the parent folders with `mkdirSync(parent, { recursive: true, mode: 0o700 })` and the relay folder itself with a plain `mkdirSync(path, { mode: 0o700 })`. Only when that call created the folder does relay run `chmodSync(path, 0o700)`, because the umask can remove bits from `mode`; when another process created the path first (`EEXIST`), relay checks it like any existing folder. When the path is a symbolic link, the link itself must belong to the current user. relay then follows the path with `stat` and checks `isDirectory()`, `uid`, `(mode & 0o022) === 0`, and that the owner has read, write and search permission (`(mode & 0o700) === 0o700`). The check functions take `uid` as a parameter, so tests can simulate another owner without root.

`resolveLogLevel(flag, env, config)` checks `RELAY_LOG_LEVEL` before it looks at the flag, so an invalid `RELAY_LOG_LEVEL` is a settings error even when `--log-level` is given.

`docs/config.example.toml` is the documented example. A test loads it and expects no problems:

```toml
# relay settings: ~/.relay/config.toml, or $RELAY_HOME/config.toml.
# relay never stores passwords, tokens or API keys in this file.

version = 1

[defaults]
# The account `relay run` uses when you do not name one.
account = "claude:personal"

[log]
# debug, info, warn or error. --log-level and RELAY_LOG_LEVEL win over this.
level = "info"

# An account is a provider and a name you choose. Each account has its own
# profile folder, where the provider's own program keeps its sign-in.
[accounts."claude:personal"]
profile_dir = "~/.claude"
kind = "personal"

[accounts."claude:startup"]
# Without profile_dir, the folder is ~/.relay/profiles/claude-startup.
kind = "work"

[accounts."codex:personal"]
profile_dir = "~/.codex"
# Names of credential variables this account may receive from your shell.
# relay removes every other credential variable when it starts an agent.
credential_env = []

# The accounts allowed to see each project. Handing work to an account sends
# the project's code to that account's company.
[[projects]]
path = "~/projects/relay"
allow = ["claude:personal", "codex:personal"]
```

### 8. Logging

Source: `architecture.md` section 8 (JSON lines, 5 files of 10 MB), `security.md` section 3 recommendation 1 (never capture the environment), and the `add-daemon-api-and-status` log format.

```ts
export type LogValue = string | number | boolean | null | string[];
export interface Logger {
  readonly file: string;
  setLevel(level: LogLevel): void;
  debug(msg: string, fields?: Record<string, LogValue>): void;
  info(msg: string, fields?: Record<string, LogValue>): void;
  warn(msg: string, fields?: Record<string, LogValue>): void;
  error(msg: string, fields?: Record<string, LogValue>): void;
}
export function openLog(opts: {
  relayHome: string;
  file: string;                 // "cli.log", "hook.log", later "daemon.log"
  level: LogLevel;
  version: string;
  invocation: string;           // 8 hex characters from crypto.getRandomValues
  maxBytes?: number;            // default 10_485_760
  keep?: number;                // default 5
  onFailure: (file: string, reason: string) => void;
  now?: () => Date;
}): Logger;
```

The field type allows no nested objects, so a caller cannot pass `process.env` or a parsed settings table by mistake. Each entry is built as `{ ts, level, msg, pid, invocation, version, ...fields }` and serialized with `JSON.stringify` plus `"\n"`, with characters that do not print written as `\u` escapes. `openLog` creates `logs/` with mode 0700, then checks with `lstat` that it is a real folder (not a symbolic link) that the current user owns, with mode 0700. Each write:

1. computes the line's byte length;
2. calls `lstatSync(file)`. An existing file must be a regular file that the current user owns, and its mode is set to 0600 before anything else, so that a rotated file never keeps a looser mode. If the current size plus the line length is greater than `maxBytes`, it deletes `<file>.<keep>`, renames `<file>.<n>` to `<file>.<n+1>` from `keep - 1` down to 1, then renames `<file>` to `<file>.1`. A file that another relay process has already moved (`ENOENT`) is skipped;
3. opens the file with `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK` and mode 0600, checks with `fstat` that it is a regular file the current user owns, sets mode 0600 with `fchmod` when the umask removed bits, writes the line through the same descriptor, and closes it. `O_NOFOLLOW` refuses a symbolic link, and `O_NONBLOCK` makes a named pipe without a reader fail at once instead of stopping relay.

Any error in `openLog` or in a write calls `onFailure` once and turns the logger off for the rest of the run. In `runCli`, `onFailure` prints the warning from the relay-logging spec, except for `hook`. The reason in the warning is the system's message without the system call and path, for example `EACCES: permission denied`. Two relay processes that rotate at the same moment can lose a few lines. That is accepted for a log, and the daemon change has its own single writer.

The `unexpected error` entry holds `error_name` and the stack frames only. The message and the first line of the stack, which repeats it, are never logged, because later adapters may throw errors that quote a command line or a provider's output.

Events written in this change: `command started`, `settings loaded`, `settings invalid` (warn), `command finished`, `unexpected error` (error), `command interrupted` (warn), `hook ignored: not built yet`, `hook usage error`.

### 9. Test setup and the fake provider

Source: `architecture.md` section 9, items 1 and 6; `openspec/config.yaml` ("Tests never call real providers"); earlier research on agent session formats ("relay must manage stdin and output explicitly").

`test/setup.ts` (preloaded by `bunfig.toml`) runs once per `bun test` process:

```ts
const root = mkdtempSync(join(realpathSync(tmpdir()), "relay-test-"));
process.env.HOME = join(root, "home");           // created
process.env.RELAY_HOME = join(root, "relay-home"); // not created
for (const name of [...CREDENTIAL_VARS, ...SETTINGS_VARS]) delete process.env[name];
// also every GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n>
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.RELAY_LOG_LEVEL;
process.env.PATH = `${GUARD_BIN}${delimiter}${process.env.PATH}`;
process.env.RELAY_TEST = "1";                     // add-relay-switch reads it for its crash tests
// Bun.spawn, Bun.spawnSync and Bun.which are wrapped here (see below)
afterAll(() => rmSync(root, { recursive: true, force: true }));
```

`CREDENTIAL_VARS` is the list in the build-and-ci spec. `SETTINGS_VARS` is `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_COUNT`. git reads these variables, and a git hook that starts the tests can set the `GIT_` ones, so removing them keeps the person's git settings and repository out of the tests.

The cleanup uses `afterAll` from `bun:test`, because `bun test` does not emit the process `exit` event; an `afterAll` hook in a preload runs once, after all test files.

`Bun.spawn`, `Bun.spawnSync` and `Bun.which` use the environment Bun started with, not the changed `process.env`, unless they are given one (checked with Bun 1.4.2). Without a fix, a test that starts `claude` without an `env` option would run the real program with the real `HOME` and credential variables. The preload therefore wraps the three functions: when a call gives no `env` option (or, for `Bun.which`, no `PATH` option), the wrapper passes the current `process.env` (or its `PATH`). `test/setup.test.ts` proves that a call without these options reaches the guard programs. `node:child_process` and `Bun.$` already use the changed `process.env`. `GUARD_BIN` is `test/fixtures/fake-provider/guard-bin`, which holds two executable shell scripts, `claude` and `codex`. Each prints `Tests must not start the real <name>. Use test/fixtures/fake-provider instead.` to standard error and exits 97.

`test/helpers/home.ts` `makeRelayHome(configText?, mode = 0o600)` creates a new folder under the preload's root for each test. When `configText` is given, it writes `config.toml` with that mode. Tests never commit text that looks like a real credential. A planted value is built at run time, for example `"sk-ant-" + "test-123"`, so the secret scan in CI stays clean.

`test/helpers/cli.ts`:

- `runRelayInProcess(args, { env?, relayHome?, stdin?, commands? })` calls `runCli` with captured `out` and `err` and returns `{ code, stdout, stderr }`. Most tests use it.
- `runRelay(args, { env?, cwd?, stdin? })` starts `bun --no-env-file src/cli/main.ts` with `Bun.spawn` and returns `{ code, stdout, stderr }`. Tests use it for signals, standard input, `.env` and a full logging check.

The fake provider, in `test/fixtures/fake-provider/`:

- `fake-agent.ts` runs as `bun test/fixtures/fake-provider/fake-agent.ts <scenario.json>`. A scenario is `{ "description": string, "steps": Step[] }`, where a step is `{ "stdout": string }`, `{ "stderr": string }`, `{ "sleep_ms": number }` or `{ "exit": number }`. Steps run in order. Without an `exit` step, the program exits 0. Any other step prints `fake agent: unknown step` to standard error and exits 2. When `FAKE_AGENT_RECORD` names a file, the program first writes `{ "argv": [...], "cwd": "...", "env_names": [...] }` there, with the variable names sorted and never their values.
- `scenarios/finish-ok.json` prints `working` and `done`, then exits 0. `scenarios/crash.json` prints `fake agent crashed` to standard error and exits 1. `scenarios/slow.json` waits 200 ms, then exits 0.
- `README.md` describes the format. Phase 3 (`add-provider-adapters`) adds `test/fakes/fake-claude.ts` and `test/fakes/fake-codex.ts`, which speak the real tools' output formats; this simple fake agent stays for tests that only need a scripted child process.

### 10. Builds and the smoke test

Source: `architecture.md` section 1 ("Code signing on macOS") and section 8; Bun's executables documentation.

Each binary is built on its own platform: macOS arm64 on a `macos-26` runner, and Linux x64 on `ubuntu-24.04` or the Omarchy machine. A macOS arm64 binary must carry a signature to run, and building it on a Mac avoids relying on cross-compilation for that. This change does no Developer ID signing and no notarization. `codesign -dv dist/relay-darwin-arm64` is run and printed in CI as a record of the signature the build produced.

`scripts/smoke-test.sh <binary> <expected version>`:

```sh
#!/bin/sh
set -eu
bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
want="relay $2"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export RELAY_HOME="$tmp/relay-home"
[ "$("$bin" --version)" = "$want" ] || { echo "Wrong version output"; exit 1; }
"$bin" --help >/dev/null
mkdir "$tmp/project" && printf 'RELAY_LOG_LEVEL=loud\n' > "$tmp/project/.env"
set +e; (cd "$tmp/project" && "$bin" status 2>/dev/null); code=$?; set -e
[ "$code" -eq 69 ] || { echo "Expected exit 69 from status, got $code"; exit 1; }
[ -f "$RELAY_HOME/logs/cli.log" ] || { echo "No log written"; exit 1; }
echo "Smoke test passed: $1"
```

`test/build/no-network.test.ts` checks that relay opens no network connections. It parses every code file under `src/` with the TypeScript compiler, through the API that TypeScript 7 publishes as `typescript/unstable/async`, so comments and the text of strings never count. It looks for the name `fetch` (which also finds `globalThis.fetch`), imports and `require` calls of the modules `net`, `http`, `https`, `http2`, `dgram` and `tls`, with or without the `node:` prefix, `Bun.connect`, `Bun.listen`, `Bun.serve`, `Bun.udpSocket`, `XMLHttpRequest`, `EventSource` and `WebSocket`. Any match outside `src/client/` fails the test. Inside `src/client/`, where `add-daemon-api-and-status` puts the client for relay's Unix socket, a match is allowed only when it is a call to `fetch` or `Bun.connect` that passes an object with a `unix:` key directly as an argument. A `unix` property in a nested object, such as the headers, does not count.

### 11. Continuous integration

Source: `security.md` section 8, recommendations 4 and 6; section 3, recommendation 3 (gitleaks).

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  check:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-26]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version-file: package.json
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test
  build:
    needs: check
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-26
            target: darwin-arm64
          - os: ubuntu-24.04
            target: linux-x64
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version-file: package.json
      - run: bun install --frozen-lockfile
      - run: bun run build:${{ matrix.target }}
      - if: runner.os == 'macOS'
        run: codesign -dv dist/relay-darwin-arm64
      - run: sh scripts/smoke-test.sh dist/relay-${{ matrix.target }} "$(bun -p 'require("./package.json").version')"
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: relay-${{ matrix.target }}
          path: dist/relay-${{ matrix.target }}
          retention-days: 7
          if-no-files-found: error
  security:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          fetch-depth: 0
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version-file: package.json
      - name: Every action is pinned to a commit SHA
        run: |
          if grep -rnE '^\s*(-\s*)?uses:' .github/workflows | grep -vE 'uses: [^@ ]+@[0-9a-f]{40} # v[0-9]'; then
            echo "Pin every action to a full commit SHA followed by a version comment."
            exit 1
          fi
      - run: bun install --frozen-lockfile
      - run: bun audit
      - name: Secret scan (gitleaks 8.30.1)
        run: |
          cd "$RUNNER_TEMP"
          curl -sSfL -o gitleaks.tar.gz https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
          echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  gitleaks.tar.gz" | sha256sum --check --strict
          tar -xzf gitleaks.tar.gz gitleaks
          cd "$GITHUB_WORKSPACE"
          "$RUNNER_TEMP/gitleaks" git --redact --verbose --exit-code 1 .
```

`.github/dependabot.yml` checks `github-actions` and `bun` weekly in `/`. Dependabot updates SHA-pinned actions together with their version comments, so the pin check keeps passing.

Alternatives considered: `gitleaks/gitleaks-action` (rejected because its license is no longer open source since v2, it needs the workflow token, and it downloads gitleaks without a pinned checksum), and a TruffleHog action (rejected because gitleaks is also the scanner that `add-checkpoint-engine` uses).

### 12. Documents

- `docs/cli.md`: the commands table, the exit-code table (parsed by a test), output rules (`relay: ` prefix, standard output and standard error), the log files and their fields, and how to add a command.
- `docs/config.md`: `RELAY_HOME`, the folder layout (`config.toml` and `logs/` now; `profiles/`, `accounts/`, `jobs/`, `locks/`, `tmp/`, `spool/`, `run/`, `projects.list` and `relay.db` are named by later changes), every setting with its type, default and an example, the problem messages, and why credentials are refused. It includes `docs/config.example.toml` by reference.
- `docs/development.md`: install Bun 1.4.2 on the Omarchy machine, `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run build:linux-x64`, `sh scripts/smoke-test.sh dist/relay-linux-x64 0.1.0`, the fake provider, and why not to build on the Mac.
- `README.md`: one "Development" line pointing to `docs/development.md`.

## Risks / Trade-offs

- [Bun 1.4.2 might behave differently from the documentation read on bun.com, which follows Bun's main branch] → Every fact used here was checked against the `bun-v1.4.2` tag or the 1.4.2 help output. The first task stops if `bun init` writes anything other than what decision 1 expects.
- [The command syntax in help may differ from what later phases build] → The help says "Not built yet", and each later change owns its command's syntax and golden file (decision 3).
- [Rejecting unknown keys means an older relay refuses a newer `config.toml`] → The `version` key gives a clear "Update relay" message. Typos are caught early, which matters for allow lists.
- [Binaries are tens of megabytes, and the Mac has little disk] → No builds on the Mac. CI artifacts are kept for 7 days.
- [`bun audit` and gitleaks need network access in CI] → They run only in the `security` job. A registry outage fails that job, and it can be rerun.
- [The ownership checks reject a shared `RELAY_HOME`, for example on a team machine] → That is intended. Allow lists must not be writable by others (`security.md` section 6).

## Migration Plan

There is nothing to migrate. Rolling back means reverting the pull requests. No file on the person's machine is changed except the new `~/.relay/logs/`.

## Open Questions

- When a Bun release includes `bun check`, should the `typecheck` script switch to it? This changes no spec and no task.
