// Preloaded by bunfig.toml once per `bun test` process. It keeps tests away from the person's
// real home folder, real relay folder, credential variables, git settings and real agent programs.
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "CURSOR_API_KEY",
];
// Programs, git among them, read settings from these folders and variables, and a git hook that
// starts the tests can set the GIT_ ones.
const SETTINGS_VARS = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
];
const GUARD_BIN = join(import.meta.dir, "fixtures", "fake-provider", "guard-bin");

const root = mkdtempSync(join(realpathSync(tmpdir()), "relay-test-"));
process.env.HOME = join(root, "home");
mkdirSync(process.env.HOME);
process.env.RELAY_HOME = join(root, "relay-home");
for (const name of [...CREDENTIAL_VARS, ...SETTINGS_VARS]) delete process.env[name];
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_CONFIG_KEY_") || name.startsWith("GIT_CONFIG_VALUE_")) delete process.env[name];
}
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.RELAY_LOG_LEVEL;
// The git guard program (guard-bin/git) lets git through only when this is set; only the git
// runner, the scratch-repository helpers and the evaluation harness's git runner
// (eval/handoff/src/git.ts) may set it, for their own child processes.
delete process.env.RELAY_GIT_RUNNER;
process.env.PATH = `${GUARD_BIN}${delimiter}${process.env.PATH}`;
process.env.RELAY_TEST = "1";

// Bun.spawn, Bun.spawnSync and Bun.which use the environment Bun started with, not the changed
// process.env, unless they are given one. These wrappers give them process.env by default.
type SpawnArgs = [unknown, Record<string, unknown>?];
function withEnv(args: SpawnArgs): SpawnArgs {
  const [first, options] = args;
  if (Array.isArray(first)) {
    return options?.env === undefined ? [first, { ...options, env: process.env }] : args;
  }
  const spec = first as Record<string, unknown>;
  return spec.env === undefined ? [{ ...spec, env: process.env }, options] : args;
}
const spawn = Bun.spawn as (...args: SpawnArgs) => unknown;
const spawnSync = Bun.spawnSync as (...args: SpawnArgs) => unknown;
const which = Bun.which;
Bun.spawn = ((...args: SpawnArgs) => spawn(...withEnv(args))) as typeof Bun.spawn;
Bun.spawnSync = ((...args: SpawnArgs) => spawnSync(...withEnv(args))) as typeof Bun.spawnSync;
Bun.which = (command, options) => which(command, { ...options, PATH: options?.PATH ?? process.env.PATH });

// bun test does not emit the process "exit" event. An afterAll hook in a preload runs once, after
// all test files.
afterAll(() => rmSync(root, { recursive: true, force: true }));
