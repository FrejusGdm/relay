import { join } from "node:path";
import { notBuilt } from "../../src/cli/commands/not-built";
import { COMMANDS, type CommandDef, type CommandName } from "../../src/cli/commands/registry";
import { runCli } from "../../src/cli/run";
import { makeRelayHome } from "./home";

export interface RelayResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

// A command that exists only in tests and is never built. Tests of the not-built path pass
// WITH_UNBUILT as `commands`, so they keep working when the real commands get built.
export const UNBUILT = "unbuilt-for-tests";
export const WITH_UNBUILT: CommandDef[] = [
  ...COMMANDS,
  {
    name: UNBUILT as CommandName,
    usage: `relay ${UNBUILT} [<value>]`,
    argsUsage: "[<value>]",
    summary: "A command that is never built",
    details: [],
    examples: [],
    options: [],
    minArgs: 0,
    maxArgs: 1,
    quiet: false,
    built: false,
    handler: notBuilt,
  },
];

// Without a relay folder in the options, each run gets a new one from makeRelayHome, so no test
// writes to the preload's RELAY_HOME.
export async function runRelayInProcess(
  args: string[],
  options: {
    env?: Record<string, string>;
    relayHome?: string;
    stdin?: string;
    // With answers, standard input acts as a terminal that gives these lines one by one.
    answers?: string[];
    commands?: CommandDef[];
    uid?: number;
    cwd?: string;
    // Simulates a terminal in which the person types `answer`. `beforeAnswer` runs while relay
    // waits for it.
    terminal?: { answer: string | null; beforeAnswer?: () => void };
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
      stdinIsTTY: options.answers !== undefined,
      stdoutIsTTY: false,
      readStdin: async (maxBytes) => Buffer.from(options.stdin ?? "").subarray(0, maxBytes),
      isTerminal: options.terminal !== undefined,
      readLine: async () => {
        if (options.answers !== undefined) return options.answers.shift() ?? null;
        options.terminal?.beforeAnswer?.();
        return options.terminal?.answer ?? null;
      },
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
