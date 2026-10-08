import { join } from "node:path";
import type { CommandDef } from "../../src/cli/commands/registry";
import { runCli } from "../../src/cli/run";
import { makeRelayHome } from "./home";

export interface RelayResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

// Without a relay folder in the options, each run gets a new one from makeRelayHome, so no test
// writes to the preload's RELAY_HOME.
export async function runRelayInProcess(
  args: string[],
  options: {
    env?: Record<string, string>;
    relayHome?: string;
    stdin?: string;
    commands?: CommandDef[];
    uid?: number;
    cwd?: string;
    // Simulates a terminal in which the person types `answer`.
    terminal?: { answer: string | null };
  } = {},
): Promise<RelayResult> {
  let stdout = "";
  let stderr = "";
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };
  env.RELAY_HOME = options.relayHome ?? options.env?.RELAY_HOME ?? makeRelayHome();
  const code = await runCli({
    argv: args,
    cwd: options.cwd ?? process.cwd(),
    env,
    homedir: env.HOME!,
    uid: options.uid ?? process.getuid!(),
    io: {
      out: (text) => (stdout += text),
      err: (text) => (stderr += text),
      stdinIsTTY: false,
      readStdinToEnd: async () => options.stdin ?? "",
      isTerminal: options.terminal !== undefined,
      readLine: async () => options.terminal?.answer ?? null,
    },
    commands: options.commands,
  });
  return { code, stdout, stderr };
}

// Starts relay as its own process. The environment is always passed explicitly, so the child
// gets the test HOME, RELAY_HOME and PATH (design decision 9). Without RELAY_HOME in options.env,
// the child gets a new relay folder.
export async function runRelay(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string; stdin?: string | Uint8Array } = {},
): Promise<RelayResult> {
  const child = Bun.spawn([process.execPath, "--no-env-file", MAIN, ...args], {
    env: { ...process.env, RELAY_HOME: makeRelayHome(), ...options.env },
    cwd: options.cwd,
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}
