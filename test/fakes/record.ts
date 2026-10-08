// What a fake program writes to the file named by RELAY_FAKE_RECORD, so tests can check how relay
// started it. The record holds the names of the environment variables, never their values, except
// for the four variables below that tell which account and job the fake ran for.
import { fstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isatty } from "node:tty";

export type StdinKind = "terminal" | "pipe" | "eof";

const RECORDED_VALUES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "RELAY_JOB", "RELAY_TARGET"] as const;

export interface FakeRecord {
  argv: string[];
  cwd: string;
  env_names: string[];
  env: Record<(typeof RECORDED_VALUES)[number], string | null>;
  stdin: StdinKind;
  input: string[];                    // every input line or JSON-RPC message the fake read, in order
}

// A pipe from Bun or Node is a socket or a FIFO. "ignore" gives /dev/null, which reads as end of file.
export function stdinKind(): StdinKind {
  if (isatty(0)) return "terminal";
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isSocket() ? "pipe" : "eof";
  } catch {
    return "eof";
  }
}

export interface Recorder {
  input(line: string): void;
}

// Writes the first record at once. Returns null when RELAY_FAKE_RECORD is not set.
export function startRecord(argv: string[], file = process.env.RELAY_FAKE_RECORD): Recorder | null {
  if (file === undefined || file === "") return null;
  const record: FakeRecord = {
    argv,
    cwd: process.cwd(),
    env_names: Object.keys(process.env).sort(),
    env: Object.fromEntries(RECORDED_VALUES.map((name) => [name, process.env[name] ?? null])) as FakeRecord["env"],
    stdin: stdinKind(),
    input: [],
  };
  const save = () => {
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, file);
  };
  save();
  return {
    input(line: string) {
      record.input.push(line);
      save();
    },
  };
}

// For tests: reads a record the fake wrote.
export function readRecord(file: string): FakeRecord {
  return JSON.parse(readFileSync(file, "utf8")) as FakeRecord;
}
