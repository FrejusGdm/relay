// The trust record of git configuration and hooks (design.md decision 11, docs/git-safety.md).
// `relay init` records what git would read; later commands compare before running other git
// commands and stop when something changed. Values are never stored: for each key the record
// keeps how often it occurs and a keyed hash of its values.
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { replaceInvisible } from "../text/invisible";
import type { Repository } from "./repo";
import { git } from "./run";

interface ConfigKey {
  name: string;
  count: number;
  // HMAC-SHA256 of the key's values in this file, in order, keyed with the record's values_salt.
  values_hmac: string;
}

interface ConfigFile {
  path: string;
  scope: string;
  sha256: string | null;
  keys: ConfigKey[];
}

interface HookFolder {
  dir: string;
  entries: { name: string; mode: string; sha256: string | null }[];
}

interface CurrentState {
  // Every key git reads, across all files, with the count and HMAC of all its values in the order
  // git reads them, so a change of which value wins is seen even when no file's bytes changed.
  keys: ConfigKey[];
  config_files: ConfigFile[];
  attributes_file: { path: string; sha256: string | null };
  hooks: HookFolder;
  // The folder named by core.hooksPath, when it is set and is not part of the worktree's files.
  hooks_path: HookFolder | null;
}

interface TrustRecord extends CurrentState {
  schema_version: 1;
  job_id: string;
  recorded_at: string;
  worktree_root: string;
  values_salt: string;
}

export type TrustChange =
  | { kind: "config"; path: string; addedKeys: string[]; removedKeys: string[]; changedKeys: string[] }
  | { kind: "attributes"; path: string }
  // Keys whose values, taken across all files in git's order, changed while no file's own keys did.
  | { kind: "order"; changedKeys: string[] }
  | { kind: "hook"; path: string; change: "added" | "removed" | "changed" };

// A trust record that is missing or cannot be read as a record. `relay accept-git-changes` can
// write a new one.
export class TrustRecordError extends Error {
  constructor(readonly problem: "missing" | "damaged", readonly file: string) {
    super(`The git trust record ${file} is ${problem}.`);
    this.name = "TrustRecordError";
  }
}

const TRUST_FILE = "git-trust.json";
// Configuration, attribute and hook files larger than this are refused instead of read.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Keys whose value names a program git may start (design.md decision 11).
const RUNS_COMMANDS = [
  /^core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)$/i,
  /^diff\.external$/i,
  /^diff\..+\.(textconv|command)$/i,
  /^(diff|merge)\.(tool|guitool)$/i,
  /^filter\..+\.(clean|smudge|process)$/i,
  /^merge\..+\.driver$/i,
  /^credential\.(.+\.)?helper$/i,
  /^gpg\.(.+\.)?program$/i,
  /^gpg\.ssh\.defaultkeycommand$/i,
  /^sequence\.editor$/i,
  /^include\.path$/i,
  /^includeif\..+\.path$/i,
  /^alias\./i,
  /^uploadpack\.packobjectshook$/i,
  /^hook\..+\.(command|event)$/i,
  /^pager\./i,
  /^trailer\..+\.(command|cmd)$/i,
  /^remote\..+\.(uploadpack|receivepack|vcs)$/i,
  /^submodule\..+\.update$/i,
  /^interactive\.difffilter$/i,
  /^gc\.recentobjectshook$/i,
  /^tar\..+\.command$/i,
  /^imap\.tunnel$/i,
  /^sendemail\.(.+\.)?([a-z]*cmd|smtpserver)$/i,
  /^(difftool|mergetool|browser|man)\..+\.(cmd|path)$/i,
  /^guitool\..+\.cmd$/i,
  /^man\.viewer$/i,
  /^(web|help|instaweb)\.browser$/i,
  /^instaweb\.httpd$/i,
];
const KEY_WARNINGS: [RegExp, string][] = [
  [/^core\.worktree$/i, "changes where git writes files"],
];

// Every other format character and line or paragraph separator, such as U+061C, U+2028 and U+2029.
const FORMAT = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
// C0 controls, DEL and C1 controls.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

const decoder = new TextDecoder();

// Writes $RELAY_HOME/jobs/<job>/git-trust.json. `jobDir` is that job folder; its name is the job ID.
export async function recordTrust(repo: Repository, jobDir: string): Promise<void> {
  const salt = randomBytes(32).toString("hex");
  writeRecord(repo, jobDir, salt, await readCurrent(repo, salt));
}

function writeRecord(repo: Repository, jobDir: string, salt: string, current: CurrentState): void {
  const record: TrustRecord = {
    schema_version: 1,
    job_id: basename(jobDir),
    recorded_at: new Date().toISOString(),
    worktree_root: repo.worktreeRoot,
    values_salt: salt,
    ...current,
  };
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  chmodSync(jobDir, 0o700);
  const file = join(jobDir, TRUST_FILE);
  const temporary = `${file}.tmp`;
  // A stale temporary file, or a link planted in its place, is removed rather than written through.
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const dirFd = openSync(jobDir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

// Returns what changed since recordTrust, or an empty list. Runs only `git config` and
// `git rev-parse`, which start no hooks and no file-system monitor.
export async function compareTrust(repo: Repository, jobDir: string): Promise<TrustChange[]> {
  const stored = readRecord(join(jobDir, TRUST_FILE));
  return changesSince(stored, await readCurrent(repo, stored.values_salt));
}

// For relay accept-git-changes: what changed since the record, or the reason the record cannot be
// read (`problem`), and `accept`, which writes a new record of exactly the state compared here.
// A change made after the person saw the report is therefore not trusted with it.
export async function reviewTrust(
  repo: Repository,
  jobDir: string,
): Promise<{ problem: TrustRecordError | null; changes: TrustChange[]; accept: () => void }> {
  let stored: TrustRecord | null = null;
  let problem: TrustRecordError | null = null;
  try {
    stored = readRecord(join(jobDir, TRUST_FILE));
  } catch (error) {
    if (!(error instanceof TrustRecordError)) throw error;
    problem = error;
  }
  const salt = stored?.values_salt ?? randomBytes(32).toString("hex");
  const current = await readCurrent(repo, salt);
  return {
    problem,
    changes: stored === null ? [] : changesSince(stored, current),
    accept: () => writeRecord(repo, jobDir, salt, current),
  };
}

function changesSince(stored: TrustRecord, current: CurrentState): TrustChange[] {
  const changes: TrustChange[] = configChanges(stored.config_files, current.config_files);
  const named = new Set(changes.flatMap((change) => (change.kind === "config" ? [...change.addedKeys, ...change.removedKeys, ...change.changedKeys] : [])));
  const order = keyChanges(stored.keys, current.keys).filter((name) => !named.has(name));
  if (order.length > 0) changes.push({ kind: "order", changedKeys: order });
  if (stored.attributes_file.path !== current.attributes_file.path || stored.attributes_file.sha256 !== current.attributes_file.sha256) {
    changes.push({ kind: "attributes", path: current.attributes_file.path });
  }
  changes.push(...hookChanges([stored.hooks, stored.hooks_path], [current.hooks, current.hooks_path]));
  return changes;
}

// The files whose hashes or keys changed, for the checkpoint_refused and git_changes_accepted events.
export function changedFiles(changes: TrustChange[]): string[] {
  return [...new Set(changes.flatMap((change) => (change.kind === "order" ? [] : [change.path])))];
}

// The lines relay prints when it refuses to run git (the git-safety spec). Every name and path is
// passed through `visible`, so a crafted key or file name cannot move the cursor or hide text.
export function trustReport(changes: TrustChange[], repo: Repository): string[] {
  const lines: string[] = [];
  for (const change of changes) {
    if (change.kind === "hook") continue;
    if (change.kind === "order") {
      lines.push("Stopped: the order in which git reads its settings changed since this job started.");
      for (const key of change.changedKeys) lines.push(`  changed  ${describeKey(key)}`);
      continue;
    }
    lines.push(`Stopped: ${visible(displayPath(change.path, repo))} changed since this job started.`);
    if (change.kind === "attributes") continue;
    for (const key of change.addedKeys) lines.push(`  added  ${describeKey(key)}`);
    for (const key of change.removedKeys) lines.push(`  removed  ${describeKey(key)}`);
    for (const key of change.changedKeys) lines.push(`  changed  ${describeKey(key)}`);
    if (change.addedKeys.length + change.removedKeys.length + change.changedKeys.length === 0) {
      lines.push("  changed comments, spacing or the order of settings");
    }
  }
  const hooks = changes.filter((change) => change.kind === "hook");
  if (hooks.length > 0) {
    lines.push("Stopped: the git hooks changed since this job started.");
    const defaultFolder = join(repo.commonDir, "hooks");
    for (const hook of hooks) {
      const name = dirname(hook.path) === defaultFolder ? basename(hook.path) : displayPath(hook.path, repo);
      lines.push(`  ${hook.change}  ${visible(name)}`);
    }
  }
  lines.push(
    "relay will not run git here until you check this change.",
    "If you made it yourself, run relay accept-git-changes in your terminal.",
  );
  return lines;
}

async function readCurrent(repo: Repository, salt: string): Promise<CurrentState> {
  checkConfigFiles(repo);
  // Values pass through memory only to be counted and hashed; they are never stored or printed.
  const listing = await git(repo, ["config", "--list", "--show-origin", "--show-scope", "-z"]);
  if (listing.code !== 0) throw new Error(`relay could not read the git configuration: ${visible(listing.stderr.trim())}`);
  const files = new Map<string, { scope: string; values: Map<string, (string | null)[]> }>();
  const all = new Map<string, (string | null)[]>();
  // The last value git read wins, as it does for git itself.
  const last = new Map<string, string | null>();
  const fields = decoder.decode(listing.stdout).split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [scope, origin, entry] = [fields[i]!, fields[i + 1]!, fields[i + 2]!];
    // relay's own -c overrides.
    if (scope === "command") continue;
    if (!origin.startsWith("file:")) throw new Error(`relay cannot check git settings that come from ${visible(origin)}`);
    const path = resolve(repo.worktreeRoot, origin.slice("file:".length));
    const file = files.get(path) ?? { scope, values: new Map() };
    // `key\nvalue`, or `key` alone for a key written without a value.
    const newline = entry.indexOf("\n");
    const name = hideUrlSecrets(newline === -1 ? entry : entry.slice(0, newline));
    const value = newline === -1 ? null : entry.slice(newline + 1);
    last.set(name.toLowerCase(), value);
    const values = file.values.get(name) ?? [];
    values.push(value);
    file.values.set(name, values);
    all.set(name, [...(all.get(name) ?? []), value]);
    files.set(path, file);
  }

  const paths = await git(repo, [
    "rev-parse", "--path-format=absolute", "--git-path", "config", "--git-path", "config.worktree", "--git-path", "info/attributes",
  ]);
  if (paths.code !== 0) throw new Error(`git rev-parse failed: ${visible(paths.stderr.trim())}`);
  const [repoConfig, worktreeConfig, attributes] = decoder.decode(paths.stdout).split("\n") as [string, string, string];
  // These files are recorded even when empty or missing, so creating one is a change.
  if (!files.has(repoConfig)) files.set(repoConfig, { scope: "local", values: new Map() });
  if (isTrue(last.get("extensions.worktreeconfig")) && !files.has(worktreeConfig)) {
    files.set(worktreeConfig, { scope: "worktree", values: new Map() });
  }

  const hooksDir = join(repo.commonDir, "hooks");
  const hooksPath = last.get("core.hookspath");
  const configured = hooksPath === undefined || hooksPath === null ? null : realPath(resolve(repo.worktreeRoot, expandHome(hooksPath)));
  const hmacKey = Buffer.from(salt, "hex");
  const fingerprints = (values: Map<string, (string | null)[]>): ConfigKey[] =>
    [...values.keys()].sort().map((name) => {
      const list = values.get(name)!;
      return { name, count: list.length, values_hmac: createHmac("sha256", hmacKey).update(JSON.stringify(list)).digest("hex") };
    });

  return {
    keys: fingerprints(all),
    config_files: [...files].map(([path, file]) => ({ path, scope: file.scope, sha256: hashFile(path), keys: fingerprints(file.values) })),
    attributes_file: { path: attributes, sha256: hashFile(attributes) },
    hooks: readHookFolder(hooksDir),
    hooks_path: configured === null || configured === realPath(hooksDir) || isProjectPath(configured, repo) ? null : readHookFolder(configured),
  };
}

// git's reading of a boolean setting; a key written without a value is true.
function isTrue(value: string | null | undefined): boolean {
  if (value === undefined) return false;
  if (value === null) return true;
  const text = value.trim().toLowerCase();
  return text === "true" || text === "yes" || text === "on" || (/^-?\d+$/.test(text) && Number(text) !== 0);
}

// git expands a leading ~/ to the home folder and ~user/ to that user's home folder.
function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  const slash = path.indexOf("/");
  const user = slash === -1 ? path.slice(1) : path.slice(1, slash);
  const rest = slash === -1 ? "" : path.slice(slash + 1);
  const home = user === "" || user === userInfo().username ? process.env.HOME : homeOf(user);
  if (!home) throw new Error(`relay cannot find the home folder named in core.hooksPath: ${visible(path)}`);
  return join(home, rest);
}

// Another user's home folder, from /etc/passwd.
function homeOf(user: string): string | undefined {
  const passwd = readRegularFile("/etc/passwd", true)?.toString("utf8") ?? "";
  return passwd.split("\n").map((line) => line.split(":")).find((fields) => fields[0] === user)?.[5];
}

// The path with every symbolic link resolved, or the path itself when it does not exist.
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isMissing(error)) return path;
    throw error;
  }
}

// git reads these files before relay can list them, and a pipe or device there would make it wait
// forever, so each must be a regular file or absent. Included files are covered by the runner's
// time limit.
function checkConfigFiles(repo: Repository): void {
  const home = process.env.HOME;
  const xdg = process.env.XDG_CONFIG_HOME || (home ? join(home, ".config") : undefined);
  const gitProgram = Bun.which("git");
  const prefix = gitProgram ? dirname(dirname(realPath(gitProgram))) : undefined;
  const candidates = [
    home && join(home, ".gitconfig"),
    xdg && join(xdg, "git", "config"),
    "/etc/gitconfig",
    prefix && join(prefix, "etc", "gitconfig"),
    prefix && join(prefix, "share", "git-core", "gitconfig"),
    join(repo.commonDir, "config"),
    join(repo.gitDir, "config.worktree"),
  ];
  for (const path of candidates) {
    if (!path) continue;
    let isFile: boolean;
    try {
      isFile = statSync(path).isFile();
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!isFile) throw new Error(`relay will not run git here: ${visible(path)} is not a regular file`);
  }
}

// A key name can hold a URL, as in url.https://user:token@example.com/?access_token=x.insteadof.
// Its user name, password, query and fragment are not stored.
function hideUrlSecrets(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === last) return key;
  const subsection = key.slice(first + 1, last);
  if (!subsection.includes("://")) return key;
  const hidden = subsection.replace(/:\/\/[^/@]*@/g, "://***@").replace(/([?#]).*$/, "$1***");
  return `${key.slice(0, first + 1)}${hidden}${key.slice(last)}`;
}

// Reads a regular file. A pipe or device is refused instead of read, because reading it could
// never end.
function readRegularFile(path: string, followLinks: boolean): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (followLinks ? 0 : constants.O_NOFOLLOW));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`relay will not read ${visible(path)}: it is not a regular file`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`relay will not read ${visible(path)}: it is larger than 10 MB`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function hashFile(path: string): string | null {
  const data = readRegularFile(path, true);
  return data === null ? null : sha256(data);
}

function readHookFolder(dir: string): HookFolder {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    if (isMissing(error)) return { dir, entries: [] };
    throw error;
  }
  const entries = names.map((name) => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    // File type and every permission bit as six octal digits, such as 100755, 120777 or 040755.
    const mode = (stat.mode & 0o177777).toString(8).padStart(6, "0");
    if (stat.isSymbolicLink()) return { name, mode, sha256: sha256(readlinkSync(path)) };
    if (!stat.isFile()) return { name, mode, sha256: null };
    const data = readRegularFile(path, false);
    return { name, mode, sha256: data === null ? null : sha256(data) };
  });
  return { dir, entries };
}

function configChanges(stored: ConfigFile[], current: ConfigFile[]): TrustChange[] {
  const before = new Map(stored.map((file) => [file.path, file]));
  const after = new Map(current.map((file) => [file.path, file]));
  const changes: TrustChange[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path);
    const now = after.get(path);
    const oldKeys = new Map((old?.keys ?? []).map((key) => [key.name, key]));
    const newKeys = new Map((now?.keys ?? []).map((key) => [key.name, key]));
    const addedKeys = [...newKeys.keys()].filter((name) => !oldKeys.has(name));
    const removedKeys = [...oldKeys.keys()].filter((name) => !newKeys.has(name));
    const changedKeys = keyChanges(old?.keys ?? [], now?.keys ?? []).filter((name) => oldKeys.has(name) && newKeys.has(name));
    // Keys are compared even when the bytes are the same: a file included twice counts twice.
    if (old !== undefined && now !== undefined && old.sha256 === now.sha256 && addedKeys.length + removedKeys.length + changedKeys.length === 0) continue;
    changes.push({ kind: "config", path, addedKeys, removedKeys, changedKeys });
  }
  return changes;
}

// Names of keys that were added, removed, or whose count or values changed.
function keyChanges(stored: ConfigKey[], current: ConfigKey[]): string[] {
  const before = new Map(stored.map((key) => [key.name, key]));
  const after = new Map(current.map((key) => [key.name, key]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter((name) => {
    const old = before.get(name);
    const now = after.get(name);
    return old === undefined || now === undefined || old.count !== now.count || old.values_hmac !== now.values_hmac;
  });
}

function hookChanges(stored: (HookFolder | null)[], current: (HookFolder | null)[]): TrustChange[] {
  const flatten = (folders: (HookFolder | null)[]) =>
    new Map(folders.flatMap((folder) => folder?.entries.map((entry) => [join(folder.dir, entry.name), entry] as const) ?? []));
  const before = flatten(stored);
  const after = flatten(current);
  const changes: TrustChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(path);
    const now = after.get(path);
    if (old === undefined) changes.push({ kind: "hook", path, change: "added" });
    else if (now === undefined) changes.push({ kind: "hook", path, change: "removed" });
    else if (old.mode !== now.mode || old.sha256 !== now.sha256) changes.push({ kind: "hook", path, change: "changed" });
  }
  return changes;
}

function readRecord(file: string): TrustRecord {
  let record: unknown;
  try {
    const data = readRegularFile(file, false);
    if (data === null) throw new TrustRecordError("missing", file);
    record = JSON.parse(data.toString("utf8"));
  } catch (error) {
    if (error instanceof TrustRecordError) throw error;
    throw new TrustRecordError("damaged", file);
  }
  if (!isRecord(record)) throw new TrustRecordError("damaged", file);
  return record;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isHex64 = (value: unknown): value is string => isString(value) && /^[0-9a-f]{64}$/.test(value);
const isHash = (value: unknown) => value === null || isHex64(value);

function isHookFolder(value: unknown): value is HookFolder {
  return isObject(value) && isString(value.dir) && Array.isArray(value.entries) &&
    value.entries.every((entry) =>
      isObject(entry) && isString(entry.name) && isString(entry.mode) && /^[0-7]{6}$/.test(entry.mode) && isHash(entry.sha256));
}

function isConfigKey(key: unknown): key is ConfigKey {
  return isObject(key) && isString(key.name) && Number.isInteger(key.count) && (key.count as number) > 0 && isHex64(key.values_hmac);
}

function isConfigFile(value: unknown): value is ConfigFile {
  return isObject(value) && isString(value.path) && isString(value.scope) && isHash(value.sha256) && Array.isArray(value.keys) &&
    value.keys.every(isConfigKey);
}

function isRecord(value: unknown): value is TrustRecord {
  return isObject(value) && value.schema_version === 1 && isString(value.job_id) && isString(value.recorded_at) &&
    isString(value.worktree_root) && isHex64(value.values_salt) && Array.isArray(value.keys) && value.keys.every(isConfigKey) &&
    Array.isArray(value.config_files) && value.config_files.every(isConfigFile) &&
    isObject(value.attributes_file) && isString(value.attributes_file.path) && isHash(value.attributes_file.sha256) &&
    isHookFolder(value.hooks) && (value.hooks_path === null || isHookFolder(value.hooks_path));
}

// A path inside the worktree that is not inside a git folder: the project's own files.
// `path` has its links resolved already; the repository folders are resolved here.
function isProjectPath(path: string, repo: Repository): boolean {
  return isInside(realPath(repo.worktreeRoot), path) && !isInside(realPath(repo.gitDir), path) && !isInside(realPath(repo.commonDir), path);
}

function isInside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function displayPath(path: string, repo: Repository): string {
  if (isInside(repo.worktreeRoot, path)) return relative(repo.worktreeRoot, path);
  const home = process.env.HOME;
  if (home && isInside(home, path)) return `~/${relative(home, path)}`;
  return path;
}

// Shows control and invisible characters as \xNN or \u{NNNN}, so printing a name cannot move the
// cursor, clear a line or hide text in the terminal.
function visible(text: string): string {
  const hex = (char: string) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`;
  const controls = text.replace(CONTROL, (char) => `\\x${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return replaceInvisible(controls, hex).replace(FORMAT, hex);
}

function describeKey(key: string): string {
  const name = visible(key);
  if (RUNS_COMMANDS.some((pattern) => pattern.test(key))) return `${name} (can run commands)`;
  const warning = KEY_WARNINGS.find(([pattern]) => pattern.test(key));
  return warning === undefined ? name : `${name} (${warning[1]})`;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
