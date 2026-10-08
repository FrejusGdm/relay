// Environment that points relay at the fake agent programs, with an optional scenario file.
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenario } from "../fakes/scenario";

const FAKES = join(import.meta.dir, "..", "fakes");
export const FAKE_CLAUDE = join(FAKES, "fake-claude.ts");
export const FAKE_CODEX = join(FAKES, "fake-codex.ts");

export function fakeEnv(scenario?: Omit<Scenario, "version" | "turns"> & { turns?: Scenario["turns"] }): Record<string, string> {
  const env: Record<string, string> = { RELAY_CLAUDE_BIN: FAKE_CLAUDE, RELAY_CODEX_BIN: FAKE_CODEX, RELAY_KEEP_FAKE_ENV: "1" };
  if (scenario !== undefined) {
    const file = join(mkdtempSync(join(tmpdir(), "relay-scenario-")), "scenario.json");
    writeFileSync(file, JSON.stringify({ version: 1, turns: [], ...scenario }));
    env.RELAY_FAKE_SCENARIO = file;
  }
  return env;
}

// Every file under `folder`, with its text.
export function allFiles(folder: string): { path: string; text: string }[] {
  return readdirSync(folder, { recursive: true, encoding: "utf8" })
    .map((name) => join(folder, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

export interface ProgramCall { args: string; profile: string; apiKeySet: boolean }

// A wrapper around a fake program that logs each call and starts as signed out: the status
// commands report "signed in" only after the login command has run (and succeeded, unless
// `loginFails`).
export function loggingProgram(provider: "claude" | "codex", options: { loginFails?: boolean; signedIn?: boolean } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "relay-program-"));
  const write = (name: string, value: unknown) => {
    writeFileSync(join(folder, name), JSON.stringify(value));
    return join(folder, name);
  };
  const before = write("before.json", { version: 1, turns: [], auth: { signed_in: options.signedIn ?? false }, login: { succeed: !options.loginFails } });
  const after = write("after.json", { version: 1, turns: [], auth: { signed_in: true }, login: { succeed: !options.loginFails } });
  const log = join(folder, "calls.log");
  const mark = join(folder, "logged-in");
  const fake = provider === "claude" ? FAKE_CLAUDE : FAKE_CODEX;
  const profile = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const isLogin = provider === "claude" ? '[ "$1" = auth ] && [ "$2" = login ]' : '[ "$1" = login ] && [ $# -eq 1 ]';
  const bin = join(folder, provider);
  writeFileSync(bin, `#!/bin/sh
printf '%s|%s|%s\\n' "$*" "\${${profile}-unset}" "\${ANTHROPIC_API_KEY:+set}" >> '${log}'
export RELAY_FAKE_SCENARIO='${before}'
[ -e '${mark}' ] && export RELAY_FAKE_SCENARIO='${after}'
if ${isLogin}; then
  '${process.execPath}' '${fake}' "$@" || exit $?
  touch '${mark}'
  exit 0
fi
exec '${process.execPath}' '${fake}' "$@"
`, { mode: 0o755 });
  const calls = (): ProgramCall[] => {
    let text = "";
    try {
      text = readFileSync(log, "utf8");
    } catch {
      return [];
    }
    return text.trim().split("\n").filter(Boolean).map((line) => {
      const [args, profileValue, key] = line.split("|");
      return { args: args!, profile: profileValue!, apiKeySet: key === "set" };
    });
  };
  return { bin, calls, env: { [provider === "claude" ? "RELAY_CLAUDE_BIN" : "RELAY_CODEX_BIN"]: bin, RELAY_KEEP_FAKE_ENV: "1" } };
}
