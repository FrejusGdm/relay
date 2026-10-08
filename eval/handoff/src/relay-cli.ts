// Every relay command the harness runs (add-handoff-evaluation design decision 2). The harness
// drives relay as a black box: it starts the program with standard input closed, in an explicit
// working directory, copies its output to the run's log file, and reads its JSON.
import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { git } from "./git.ts";
import { EvalError } from "./plan.ts";

export class RelayError extends Error {}

interface AccountState {
  target: string;
  status: string;
  retry_at: string | null;
  // The highest used_percent over the account's usage windows, or null when relay reports none.
  used_percent: number | null;
}

export interface SwitchOutcome {
  exitCode: number;
  seconds: number;
  error: string;
  result: { handoff_id: number; checkpoint_sha: string; prompt_path: string; to_worker_id: string | null } | null;
}

export interface RunningRelay {
  exited: Promise<number>;
  interrupt(): void;
}

// The relay program: $RELAY_BIN, or relay on PATH.
export function findRelay(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.RELAY_BIN || "relay";
  const found = name.includes("/") ? (existsSync(resolve(name)) ? resolve(name) : null) : Bun.which(name, { PATH: env.PATH ?? "" });
  if (found === null) throw new EvalError("relay was not found. Build it first or set RELAY_BIN.", 3);
  return found;
}

function shown(args: string[]): string {
  return args.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");
}

export class Relay {
  constructor(readonly bin: string) {}

  private async call(cwd: string, args: string[], log: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([this.bin, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    appendFileSync(log, `$ relay ${shown(args)}\n${stdout}${stderr}[exit ${exitCode}]\n`);
    return { exitCode, stdout, stderr };
  }

  private async json(cwd: string, args: string[], log: string): Promise<unknown> {
    const { exitCode, stdout, stderr } = await this.call(cwd, args, log);
    const command = `relay ${shown(args)}`;
    if (exitCode !== 0) throw new RelayError(`${command} exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new RelayError(`${command} printed output that is not JSON: ${stdout.trim().slice(0, 200)}`);
    }
  }

  async init(cwd: string, title: string, log: string): Promise<void> {
    const { exitCode, stdout, stderr } = await this.call(cwd, ["init", "--title", title], log);
    if (exitCode !== 0) throw new RelayError(`relay init exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }

  // Saves a checkpoint and returns its commit. When nothing changed, relay names the latest
  // checkpoint instead, and its commit comes from the checkpoint list.
  async checkpoint(cwd: string, message: string, log: string): Promise<string> {
    const saved = await this.json(cwd, ["checkpoint", "--message", message, "--json"], log) as { saved?: boolean; commit?: unknown; latest?: unknown };
    if (saved.saved === true && typeof saved.commit === "string") return saved.commit;
    if (saved.saved === false && typeof saved.latest === "number") {
      const list = await this.json(cwd, ["checkpoints", "--json"], log);
      const found = Array.isArray(list) ? (list as { number?: unknown; commit?: unknown }[]).find((item) => item.number === saved.latest) : undefined;
      if (typeof found?.commit === "string") return found.commit;
      throw new RelayError(`relay checkpoints --json does not list checkpoint ${saved.latest}.`);
    }
    throw new RelayError("relay checkpoint --json printed an object without saved and commit or latest.");
  }

  async status(cwd: string, log: string): Promise<AccountState[]> {
    const data = await this.json(cwd, ["status", "--json"], log) as { accounts?: unknown };
    if (!Array.isArray(data.accounts)) throw new RelayError("relay status --json printed no accounts list.");
    return (data.accounts as Record<string, unknown>[]).map((account) => {
      const availability = (account.availability ?? {}) as { status?: unknown; retry_at?: unknown };
      const percents = (Array.isArray(account.usage) ? account.usage as { used_percent?: unknown }[] : [])
        .map((window) => window.used_percent).filter((value): value is number => typeof value === "number");
      return {
        target: String(account.target),
        status: typeof availability.status === "string" ? availability.status : "unknown",
        retry_at: typeof availability.retry_at === "string" ? availability.retry_at : null,
        used_percent: percents.length > 0 ? Math.max(...percents) : null,
      };
    });
  }

  // `--yes` answers only relay's own questions. A non-zero exit is a result, not an error.
  async switchTo(cwd: string, target: string, log: string): Promise<SwitchOutcome> {
    const started = Date.now();
    const { exitCode, stdout, stderr } = await this.call(cwd, ["switch", target, "--yes", "--json"], log);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (exitCode !== 0) return { exitCode, seconds, error: stderr.trim(), result: null };
    let result: SwitchOutcome["result"];
    try {
      result = JSON.parse(stdout) as SwitchOutcome["result"];
    } catch {
      throw new RelayError(`relay switch ${target} --yes --json printed output that is not JSON: ${stdout.trim().slice(0, 200)}`);
    }
    if (typeof result?.checkpoint_sha !== "string") throw new RelayError(`relay switch ${target} --yes --json printed no checkpoint_sha.`);
    return { exitCode, seconds, error: "", result };
  }

  // relay run keeps running while the agent works; its output goes to the log as it arrives.
  startRun(cwd: string, target: string, prompt: string, log: string): RunningRelay {
    appendFileSync(log, `$ relay run ${target} --headless --prompt <prompt> --json\n`);
    const child = Bun.spawn([this.bin, "run", target, "--headless", "--prompt", prompt, "--json"], {
      cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) appendFileSync(log, chunk);
    };
    const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
    const exited = child.exited.then(async (code) => {
      await drained;
      appendFileSync(log, `[exit ${code}]\n`);
      return code;
    });
    return { exited, interrupt: () => { child.kill("SIGINT"); } };
  }
}

async function version(command: string[], cwd: string): Promise<string | null> {
  try {
    const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) return null;
    const line = (stdout.trim() || stderr.trim()).split("\n")[0] ?? "";
    return /\d+\.\d+[\w.+-]*/.exec(line)?.[0] ?? (line || null);
  } catch {
    return null;
  }
}

// `--version` starts no agent and sends nothing to a provider. A program that is missing or fails
// is recorded as null.
export async function toolVersions(relayBin: string, cwd: string): Promise<Record<string, string | null>> {
  let gitVersion: string | null = null;
  try {
    const result = await git(cwd, ["--version"], { allowFailure: true });
    if (result.exitCode === 0) gitVersion = result.stdout.trim().replace(/^git version /, "");
  } catch {}
  return {
    relay: await version([relayBin, "--version"], cwd),
    claude: await version(["claude", "--version"], cwd),
    codex: await version(["codex", "--version"], cwd),
    bun: Bun.version,
    git: gitVersion,
    python3: await version(["python3", "--version"], cwd),
  };
}
