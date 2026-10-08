// How relay switch reaches a relay run in another terminal, without the daemon (add-relay-switch,
// design decision 15). The record of the running relay run is phase 3's worker lock file, to which
// this change adds the process start time, the worker ID, the mode and relay's version. relay
// switch writes a request file and sends SIGUSR1; the kernel lets a process signal only processes
// of the same user. relay run takes the request, does the switch, and writes the progress lines and
// the result next to it, which relay switch reads and prints.
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { VERSION } from "../core/version";
import type { AnswerHow } from "../handoff/ask";
import type { Preflight } from "../handoff/preflight";
import { makePrivateFolder, jobFolder, writePrivateFile } from "../handoff/files";
import { workerLockPath } from "../job/lock";
import type { Mode } from "../adapters/types";

export interface Supervisor {
  pid: number;
  account: string;
  started_at: string;
  schema_version?: number;
  process_started_at?: string | null;
  worker_id?: string;
  mode?: Mode;
  relay_version?: string;
}

// What relay switch asks the relay run to do. The answers are those the person gave in the
// terminal of relay switch; a question the relay run finds that the request does not answer stops
// the switch with exit code 7.
export interface SwitchRequest {
  to: string;
  answers: { newAccount?: AnswerHow; personalAccount?: AnswerHow; instructionFiles?: { how: AnswerHow; paths: string[] } };
  ask_for_notes: true | "flag" | "config";
  new_checks: string[] | null;
  no_start: boolean;
  client_pid: number;
  created_at: string;
}

export interface SwitchReply {
  exit_code: number;
  // The lines for standard error, and the result for --json.
  errors: string[];
  result: Record<string, unknown> | null;
}

const ANSWER_MS = 5000;
const POLL_MS = 100;
const SUPERVISOR_POLL_MS = 2000;
const OLD_REQUEST_MS = 24 * 3600_000;

// The start time of a process as ps prints it in UTC, with single spaces, or null when it does not
// run. The text is compared as it is; Date.parse reads it with " GMT" added.
export function processStartTime(pid: number): string | null {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" }, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    const text = result.stdout.toString().trim().replace(/\s+/g, " ");
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

// The fields this change adds to the worker lock of the relay run that holds it.
export function supervisorFields(workerId: string, mode: Mode): Record<string, unknown> {
  return { schema_version: 1, process_started_at: processStartTime(process.pid), worker_id: workerId, mode, relay_version: VERSION };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

// The relay run that holds the job's worker lock, when it still runs. A record whose process ID now
// belongs to another program (its start time differs) is stale: relay removes the file and never
// signals that process. A record without a start time cannot be checked, so it is never signalled.
export function readSupervisor(relayHome: string, jobId: string): (Supervisor & { checked: boolean }) | null {
  const path = workerLockPath(relayHome, jobId);
  let record: Supervisor;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as Supervisor;
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(record?.pid) || record.pid <= 0 || typeof record.account !== "string" || !alive(record.pid)) return null;
  if (typeof record.process_started_at !== "string") return { ...record, checked: false };
  if (processStartTime(record.pid) !== record.process_started_at) {
    rmSync(path, { force: true });
    return null;
  }
  return { ...record, checked: true };
}

function requestsFolder(relayHome: string, jobId: string): string {
  return join(jobFolder(relayHome, jobId), "requests");
}

// relay switch's side: writes the request, signals the relay run, prints its progress lines as they
// come, and returns its reply. A request that is not taken within 5 seconds is removed (exit 33).
export async function sendSwitchRequest(
  relayHome: string, jobId: string, supervisor: Supervisor, request: SwitchRequest, print: (line: string) => void,
): Promise<SwitchReply> {
  const folder = requestsFolder(relayHome, jobId);
  makePrivateFolder(folder);
  const id = randomBytes(8).toString("hex");
  const base = join(folder, id);
  writePrivateFile(`${base}.json`, `${JSON.stringify(request)}\n`);
  try {
    process.kill(supervisor.pid, "SIGUSR1");
  } catch {
    // The relay run also looks for requests every 2 seconds.
  }
  const deadline = Date.now() + ANSWER_MS;
  while (existsSync(`${base}.json`)) {
    if (Date.now() > deadline) {
      rmSync(`${base}.json`, { force: true });
      if (!existsSync(`${base}.taken`)) {
        throw new CommandError(ExitCode.CannotStop, [`The relay run for this job (process ${supervisor.pid}) did not answer within 5 seconds. Nothing changed.`]);
      }
      break;
    }
    await Bun.sleep(POLL_MS);
  }
  let shown = 0;
  const showNew = () => {
    let text = "";
    try {
      text = readFileSync(`${base}.log`, "utf8");
    } catch {
      return;
    }
    const lines = text.slice(shown).split("\n");
    const complete = lines.slice(0, -1);
    for (const line of complete) print(line);
    shown += complete.reduce((sum, line) => sum + line.length + 1, 0);
  };
  for (;;) {
    showNew();
    if (existsSync(`${base}.result.json`)) {
      showNew();
      const reply = JSON.parse(readFileSync(`${base}.result.json`, "utf8")) as SwitchReply;
      for (const suffix of [".taken", ".log", ".result.json"]) rmSync(`${base}${suffix}`, { force: true });
      return reply;
    }
    if (!alive(supervisor.pid)) {
      throw new CommandError(ExitCode.Failed, [`The relay run for this job (process ${supervisor.pid}) ended before it finished the switch.`]);
    }
    await Bun.sleep(POLL_MS);
  }
}

// Hands a switch to the relay process that holds the job's agent (pre.supervisor), with the answers
// the preflight collected, and returns its reply. relay switch and the daemon's switch endpoint use
// it.
export async function handSwitchOver(
  relayHome: string, pre: Preflight, options: { newChecks: string[] | null; noStart: boolean }, print: (line: string) => void,
): Promise<SwitchReply> {
  const supervisor = pre.supervisor!;
  if (!supervisor.checked) {
    throw new CommandError(ExitCode.CannotStop, [`The relay run for this job (process ${supervisor.pid}) did not answer within 5 seconds. Nothing changed.`]);
  }
  const personal = pre.confirmations.find((confirmation) => confirmation.question.startsWith("This job ran on a work account"));
  return sendSwitchRequest(relayHome, pre.job.id, supervisor, {
    to: pre.to.id,
    answers: {
      ...(pre.allowed === null ? {} : { newAccount: pre.allowed.how }),
      ...(personal === undefined ? {} : { personalAccount: personal.how }),
      ...(pre.instructionFiles === null ? {} : { instructionFiles: { how: pre.instructionFiles.how, paths: pre.instructionFiles.paths } }),
    },
    ask_for_notes: pre.askForNotes, new_checks: options.newChecks, no_start: options.noStart,
    client_pid: process.pid, created_at: new Date().toISOString(),
  }, print);
}

// relay run's side: takes the oldest request, renaming it so that it is taken once. Returns null
// when there is none.
export function takeSwitchRequest(relayHome: string, jobId: string): { id: string; request: SwitchRequest } | null {
  const folder = requestsFolder(relayHome, jobId);
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => /^[0-9a-f]{16}\.json$/.test(name));
  } catch {
    return null;
  }
  const oldest = names
    .map((name) => ({ name, time: lstatSync(join(folder, name), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => a.time - b.time);
  for (const { name } of oldest) {
    const id = name.slice(0, 16);
    try {
      renameSync(join(folder, name), join(folder, `${id}.taken`));
    } catch {
      continue;
    }
    try {
      const request = JSON.parse(readFileSync(join(folder, `${id}.taken`), "utf8")) as SwitchRequest;
      if (typeof request?.to === "string") return { id, request };
    } catch {
      // Not a request relay wrote.
    }
    rmSync(join(folder, `${id}.taken`), { force: true });
  }
  return null;
}

// Appends a progress line of request `id` for the waiting relay switch.
export function requestPrinter(relayHome: string, jobId: string, id: string): (line: string) => void {
  const path = join(requestsFolder(relayHome, jobId), `${id}.log`);
  return (line) => {
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
  };
}

export function writeSwitchReply(relayHome: string, jobId: string, id: string, reply: SwitchReply): void {
  writePrivateFile(join(requestsFolder(relayHome, jobId), `${id}.result.json`), `${JSON.stringify(reply)}\n`);
}

// Removes request files older than one day, which a relay switch that ended early left behind.
export function removeOldRequests(relayHome: string, jobId: string): void {
  const folder = requestsFolder(relayHome, jobId);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(folder, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat !== undefined && Date.now() - stat.mtimeMs > OLD_REQUEST_MS) rmSync(path, { force: true });
  }
}

// Calls `check` on SIGUSR1 and every 2 seconds, until the returned function is called.
export function listenForRequests(check: () => void): () => void {
  const onSignal = () => check();
  process.on("SIGUSR1", onSignal);
  const timer = setInterval(check, SUPERVISOR_POLL_MS);
  return () => {
    clearInterval(timer);
    process.removeListener("SIGUSR1", onSignal);
  };
}
