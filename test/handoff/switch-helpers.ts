// Shared steps for the switch tests: a job with two accounts that are both on the project's allow
// list, relay switch in the test process or as its own process, a scenario file whose sections the
// fakes read and the tests can change while relay runs, and a pseudo-terminal for interactive runs.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN, runRelayInProcess, type RelayResult } from "../helpers/cli";
import { FAKE_CLAUDE, FAKE_CODEX } from "../helpers/fake-programs";
import { runFixture, trackRun, type RunFixture } from "../run/helpers";
import type { Scenario } from "../fakes/scenario";

export const FAKE_GITLEAKS = join(import.meta.dir, "..", "helpers", "fake-gitleaks.ts");
export const SCENARIOS = join(import.meta.dir, "..", "fixtures", "scenarios");

type Section = Omit<Scenario, "version" | "turns"> & { turns?: Scenario["turns"] };

// A scenario file with one section per fake, rewritten by `set`.
export class Scenarios {
  readonly file: string;
  constructor(sections: { claude?: Section; codex?: Section } = {}) {
    this.file = join(mkdtempSync(join(tmpdir(), "relay-scenario-")), "scenario.json");
    this.set(sections);
  }

  set(sections: { claude?: Section; codex?: Section }): void {
    const full = Object.fromEntries(Object.entries(sections).map(([program, section]) => [program, { version: 1, turns: [], ...section }]));
    writeFileSync(this.file, JSON.stringify(Object.keys(full).length === 0 ? { claude: { version: 1, turns: [] } } : full));
  }

  // The section of a fixture file in test/fixtures/scenarios/.
  static fixture(name: string): Section {
    const value = JSON.parse(readFileSync(join(SCENARIOS, name), "utf8")) as Record<string, Section>;
    return Object.values(value)[0]!;
  }
}

export interface SwitchFixture extends RunFixture {
  scenarios: Scenarios;
  env: Record<string, string>;
  config(extra?: string): void;
}

// `allow` lists the accounts on the project's allow list, and null leaves the project without an
// entry in config.toml, as before its first relay run; `extra` is appended to config.toml.
export async function switchFixture(options: { allow?: string[] | null; extra?: string; accounts?: string; kind?: "full" | "empty" } = {}): Promise<SwitchFixture> {
  const accounts = options.accounts ?? '[accounts."claude:work"]\n\n[accounts."codex:personal"]\n';
  const fixture = await runFixture(accounts, options.kind ?? "full");
  const scenarios = new Scenarios();
  const write = (extra = options.extra ?? "") => {
    const allow = options.allow === undefined ? ["claude:work", "codex:personal"] : options.allow;
    const project = allow === null ? "" : `\n[[projects]]\npath = ${JSON.stringify(fixture.scratch.repo)}\nallow = ${JSON.stringify(allow)}\n`;
    writeFileSync(join(fixture.relayHome, "config.toml"),
      `${accounts}\n[handoff]\nstart_check_seconds = 1\nsummary_timeout_seconds = 10\nstop_timeout_seconds = 5\n${project}${extra}`,
      { mode: 0o600 });
  };
  write();
  const env = {
    RELAY_CLAUDE_BIN: FAKE_CLAUDE, RELAY_CODEX_BIN: FAKE_CODEX, RELAY_KEEP_FAKE_ENV: "1",
    RELAY_FAKE_SCENARIO: scenarios.file, RELAY_GITLEAKS: FAKE_GITLEAKS,
  };
  return { ...fixture, scenarios, env, config: write };
}

// relay <args> in the test process. `answers` makes standard input and output a terminal in
// which the person types these lines.
export function relayIn(fixture: SwitchFixture, args: string[], options: { env?: Record<string, string>; answers?: string[] } = {}): Promise<RelayResult> {
  const answers = options.answers === undefined ? undefined : [...options.answers];
  return runRelayInProcess(args, {
    cwd: fixture.scratch.repo, relayHome: fixture.relayHome, env: { ...fixture.env, ...options.env },
    ...(answers === undefined ? {} : { terminal: { answer: null, beforeAnswer: () => {} } }),
    ...(answers === undefined ? {} : { answers }),
  });
}

// relay <args> as its own process, leading its own process group, with standard input a pipe.
export function relayProcess(fixture: SwitchFixture, args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--no-env-file", MAIN, ...args], {
    cwd: fixture.scratch.repo, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RELAY_HOME: fixture.relayHome, ...fixture.env, ...env },
  });
  trackRun(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

// relay <args> in a pseudo-terminal. `output` holds everything the terminal showed.
export function relayTerminal(fixture: SwitchFixture, args: string[], env: Record<string, string> = {}) {
  let output = "";
  const child = Bun.spawn([process.execPath, "--no-env-file", MAIN, ...args], {
    cwd: fixture.scratch.repo,
    env: { ...process.env, RELAY_HOME: fixture.relayHome, ...fixture.env, ...env },
    terminal: { cols: 200, rows: 50, data: (_terminal, data) => { output += new TextDecoder().decode(data); } },
  });
  return { child, output: () => output, type: (text: string) => child.terminal!.write(text) };
}

export function jsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
