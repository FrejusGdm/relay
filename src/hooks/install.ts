// Adding and removing relay's hooks and status line in an account's own settings file
// (add-provider-adapters, design decision 13; the provider-hook-setup spec). relay touches only its
// own entries, keeps a backup of the old file, and writes the new one through a temporary file and
// a rename that keeps the file's mode. It never edits Codex's config.toml.
import { closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, chmodSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HookSpec, ProviderId } from "../adapters/types";
import { accountFolder, readJsonFile, writeJsonFile } from "../accounts/files";
import type { Account } from "../core/config/types";
import { now } from "../platform/clock";

type Json = Record<string, unknown>;

const RELAY_HOOK = /(^|\/|')relay'? hook (claude|codex) [A-Za-z]+$/;
const RELAY_STATUS_LINE = /(^|\/|')relay'? statusline claude$/;

export class HookFileError extends Error {}

export interface PlannedHook { event: string; command: string; timeout: number }

// relay's own path for the commands it writes: RELAY_BIN when set, otherwise the compiled relay
// program. Running from source without RELAY_BIN gives null, because the source path would not
// survive a move or an update.
export function relayProgram(env: Record<string, string | undefined>): string | null {
  if (env.RELAY_BIN) return env.RELAY_BIN;
  const compiled = Bun.main.includes("$bunfs") || Bun.main.includes("~BUN");
  return compiled ? process.execPath : null;
}

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function plannedHooks(provider: ProviderId, spec: HookSpec, program: string): PlannedHook[] {
  return spec.events.map((event) => ({
    event,
    command: `${shellQuote(program)} hook ${provider} ${event}`,
    // Codex allows at most 3 seconds for these two events.
    timeout: provider === "codex" && (event === "SessionEnd" || event === "Interrupt") ? 3 : 5,
  }));
}

export function statusLineCommand(program: string): string {
  return `${shellQuote(program)} statusline claude`;
}

export function isRelayHook(command: unknown, provider: ProviderId, event?: string): boolean {
  if (typeof command !== "string") return false;
  const match = RELAY_HOOK.exec(command);
  return match !== null && match[2] === provider && (event === undefined || command.endsWith(` ${event}`));
}

export function isRelayStatusLine(value: unknown): boolean {
  return isObject(value) && value.type === "command" && typeof value.command === "string" && RELAY_STATUS_LINE.test(value.command);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SettingsFile { path: string; exists: boolean; mode: number; data: Json }

// Reads the settings file. A missing file reads as {}. A file that is not a JSON object, or whose
// hooks value is not an object, is refused, and so is a symbolic link, which a rename would replace.
export function readSettingsFile(path: string, shown: string): SettingsFile {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return { path, exists: false, mode: 0o600, data: {} };
  if (stats.isSymbolicLink()) {
    throw new HookFileError(`${shown} is a symbolic link, so relay changed nothing. Add relay's hooks to the file it points to yourself.`);
  }
  if (!stats.isFile()) throw new HookFileError(`${shown} is not a regular file, so relay changed nothing.`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    data = undefined;
  }
  if (!isObject(data)) throw new HookFileError(`${shown} is not valid JSON, so relay changed nothing. Fix the file, then try again.`);
  if (data.hooks !== undefined && !isObject(data.hooks)) {
    throw new HookFileError(`The hooks value in ${shown} is not an object, so relay changed nothing. Fix the file, then try again.`);
  }
  return { path, exists: true, mode: stats.mode & 0o777, data };
}

// Which of relay's entries are already in the file.
export function presentHooks(data: Json, provider: ProviderId, events: string[]): string[] {
  const hooks = isObject(data.hooks) ? data.hooks : {};
  return events.filter((event) => {
    const groups = hooks[event];
    return Array.isArray(groups) && groups.some((group) =>
      isObject(group) && Array.isArray(group.hooks) && group.hooks.some((entry) => isObject(entry) && isRelayHook(entry.command, provider, event)));
  });
}

// Appends a new matcher group for each missing entry, after the person's own groups.
export function addHooks(data: Json, provider: ProviderId, planned: PlannedHook[]): { data: Json; added: PlannedHook[] } {
  const present = presentHooks(data, provider, planned.map((hook) => hook.event));
  const added = planned.filter((hook) => !present.includes(hook.event));
  if (added.length === 0) return { data, added };
  const hooks: Json = isObject(data.hooks) ? { ...data.hooks } : {};
  for (const hook of added) {
    const groups = Array.isArray(hooks[hook.event]) ? [...(hooks[hook.event] as unknown[])] : [];
    groups.push({ hooks: [{ type: "command", command: hook.command, timeout: hook.timeout }] });
    hooks[hook.event] = groups;
  }
  return { data: { ...data, hooks }, added };
}

// Removes relay's entries. A matcher group, an event and the hooks key are dropped only when they
// became empty because relay's entry was their last one.
export function removeHooks(data: Json, provider: ProviderId): { data: Json; removed: number } {
  if (!isObject(data.hooks)) return { data, removed: 0 };
  let removed = 0;
  const hooks: Json = {};
  for (const [event, groups] of Object.entries(data.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    let touched = false;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const entries = group.hooks.filter((entry) => !(isObject(entry) && isRelayHook(entry.command, provider)));
      if (entries.length === group.hooks.length) {
        kept.push(group);
        continue;
      }
      removed += group.hooks.length - entries.length;
      touched = true;
      if (entries.length > 0) kept.push({ ...group, hooks: entries });
    }
    if (kept.length > 0 || !touched) hooks[event] = kept;
  }
  const result: Json = { ...data, hooks };
  if (Object.keys(hooks).length === 0 && removed > 0) delete result.hooks;
  return { data: result, removed };
}

function backupName(file: string, time: Date): string {
  const stamp = time.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${basename(file)}.${stamp}`;
}

// Copies the old file to RELAY_HOME/accounts/<provider>-<name>/backups/ with mode 0600 and
// returns the copy's path, or null when there was no file.
export function backupSettings(relayHome: string, account: Pick<Account, "provider" | "name">, file: SettingsFile): string | null {
  if (!file.exists) return null;
  const folder = join(accountFolder(relayHome, account), "backups");
  for (const dir of [join(relayHome, "accounts"), accountFolder(relayHome, account), folder]) {
    if (lstatSync(dir, { throwIfNoEntry: false }) !== undefined) continue;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  let backup = join(folder, backupName(file.path, now()));
  for (let n = 2; lstatSync(backup, { throwIfNoEntry: false }) !== undefined; n++) backup = join(folder, `${backupName(file.path, now())}-${n}`);
  copyFileSync(file.path, backup, constants.COPYFILE_EXCL);
  chmodSync(backup, 0o600);
  return backup;
}

// Writes the JSON with two-space indentation and a final newline, through a temporary file in the
// same folder that gets the old file's mode, or 0600 for a new file.
export function writeSettings(file: SettingsFile, data: Json): void {
  mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file.path), `.${basename(file.path)}.relay-${process.pid}`);
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
    closeSync(fd);
    chmodSync(temporary, file.mode);
    renameSync(temporary, file.path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}

function originalPath(relayHome: string, account: Pick<Account, "provider" | "name">): string {
  return join(accountFolder(relayHome, account), "statusline-original.json");
}

// The person's own status line that relay's wrapper runs, or null when there was none.
export function savedStatusLine(relayHome: string, account: Pick<Account, "provider" | "name">): { saved: boolean; value: unknown } {
  const raw = readJsonFile(originalPath(relayHome, account));
  if (!isObject(raw) || raw.v !== 1 || !("original" in raw)) return { saved: false, value: null };
  return { saved: true, value: raw.original };
}

// Sets relay's status line, saving the previous value first. Returns whether a previous status
// line existed.
export function installStatusLine(relayHome: string, account: Pick<Account, "provider" | "name">, data: Json, program: string): { data: Json; hadOriginal: boolean } {
  const current = data.statusLine;
  if (!isRelayStatusLine(current)) writeJsonFile(originalPath(relayHome, account), { v: 1, original: current ?? null });
  const original = savedStatusLine(relayHome, account).value;
  return {
    data: { ...data, statusLine: { type: "command", command: statusLineCommand(program) } },
    hadOriginal: original !== null && original !== undefined,
  };
}

// Puts the saved status line back, or removes the key when there was none, and forgets the copy.
export function removeStatusLine(relayHome: string, account: Pick<Account, "provider" | "name">, data: Json): { data: Json; restored: boolean } {
  if (!isRelayStatusLine(data.statusLine)) return { data, restored: false };
  const { value } = savedStatusLine(relayHome, account);
  const result = { ...data };
  if (value === null || value === undefined) delete result.statusLine;
  else result.statusLine = value;
  rmSync(originalPath(relayHome, account), { force: true });
  return { data: result, restored: true };
}
