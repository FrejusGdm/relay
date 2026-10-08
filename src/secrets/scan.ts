// The secret scan (design.md decision 6). relay builds the text to scan itself and passes it to
// `gitleaks stdin`, with relay's own configuration, an empty ignore file and inline allow comments
// turned off, so nothing in the project can hide a finding. A table maps each line of the scan
// input back to a file and line. Findings carry the place and the rule, never the secret: the
// report's Secret, Match and Line fields are dropped while it is parsed.
import { randomBytes } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { onInterrupt } from "../core/cleanup";
import { resolveHomedir, resolveRelayHome } from "../core/paths";
import { printable } from "../core/quote";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import { isJobId } from "../job/id";
import { JOB_FILES, VERIFY_FILE } from "../job/names";

type Env = Record<string, string | undefined>;

// The command's environment, which names RELAY_HOME and RELAY_GITLEAKS (process.env when not
// given), and a shorter time limit for tests.
interface ScanOptions {
  env?: Env;
  timeoutMs?: number;
}

export interface Finding {
  path: string;
  line: number;
  rule: string;
}

// The job files whose full text every checkpoint scan reads from the new tree.
const SCANNED_JOB_FILES = [...JOB_FILES, VERIFY_FILE];
const MESSAGE_PATH = "(checkpoint message)";
const FINDINGS_EXIT = 42;
// After this time relay stops gitleaks, and the scan did not finish.
const TIME_LIMIT_MS = 120_000;
const MINIMUM = [8, 28, 0] as const;
// gitleaks' default rules, with nothing else: a project file or variable cannot add allow rules.
const CONFIG = "[extend]\nuseDefault = true\n";

function missing(): CommandError {
  return new CommandError(ExitCode.NotPossibleHere, [
    "relay needs gitleaks 8.28 or newer to check checkpoints for secrets. Install it with: brew install gitleaks",
  ]);
}

// One line of the scan input, and where it came from.
interface Place {
  path: string;
  line: number;
}

class ScanInput {
  readonly chunks: Buffer[] = [];
  readonly places: Place[] = [];

  add(line: Buffer, place: Place): void {
    this.chunks.push(line, Buffer.from("\n"));
    this.places.push(place);
  }

  // Every line of `text`, numbered from 1. A final newline does not start another line.
  addText(text: Buffer, path: string): void {
    const lines = splitLines(text);
    if (lines.at(-1)?.length === 0) lines.pop();
    lines.forEach((line, index) => this.add(line, { path, line: index + 1 }));
  }
}

// Checks that gitleaks 8.28 or newer can be run. relay init calls it before it creates anything.
export async function checkGitleaks(env: Env = process.env): Promise<void> {
  const result = await runGitleaks(["version"], env, undefined, undefined, TIME_LIMIT_MS);
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(result.stdout.trim());
  if (result.code !== 0 || match === null) throw missing();
  const version = match.slice(1).map(Number);
  for (let i = 0; i < MINIMUM.length; i++) {
    if (version[i]! > MINIMUM[i]!) return;
    if (version[i]! < MINIMUM[i]!) throw missing();
  }
}

// Scans what a checkpoint adds: the added lines between the two trees, the full text of the job
// files in the new tree, and the message. `parentTree` is null for a checkpoint without a parent.
export async function scanCheckpoint(
  repo: Repository,
  options: { jobId: string; parentTree: string | null; newTree: string; message?: string } & ScanOptions,
): Promise<Finding[]> {
  if (!isJobId(options.jobId)) throw new Error(`relay refused to use the job ID ${JSON.stringify(options.jobId)} in a path.`);
  const input = new ScanInput();
  const parent = options.parentTree ?? (await gitText(repo, ["hash-object", "-t", "tree", "/dev/null"])).trim();
  // --inter-hunk-context=0 keeps context lines out of the hunks. --text shows every added line, also of files that a NUL byte, the binary attribute or -diff
  // would otherwise turn into "Binary files differ". The runner adds --no-ext-diff and
  // --no-textconv, so no diff program or text conversion runs.
  const patch = await gitBytes(repo, [
    "diff-tree", "-p", "--text", "-U0", "--inter-hunk-context=0", "--no-renames", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "-r",
    parent, options.newTree,
  ]);
  for (const { path, line, text } of addedLines(patch)) input.add(text, { path, line });
  for (const [name, text] of await jobFileTexts(repo, options.newTree)) input.addText(text, `.relay/${name}`);
  if (options.message) input.addText(Buffer.from(options.message), MESSAGE_PATH);

  const seen = new Set<string>();
  const findings: Finding[] = [];
  // A job file's added lines are scanned twice, from the patch and from its full text.
  for (const { index, rule } of await scan(input, options.jobId, options)) {
    const finding = { ...input.places[index]!, rule };
    const key = JSON.stringify(finding);
    if (!seen.has(key)) findings.push(finding);
    seen.add(key);
  }
  return findings;
}

// Scans texts that are not in a checkpoint yet. Each part's label takes the place of a path.
export async function scanTexts(
  parts: { label: string; text: string }[],
  options: ScanOptions = {},
): Promise<{ label: string; line: number; rule: string }[]> {
  const input = new ScanInput();
  for (const part of parts) input.addText(Buffer.from(part.text), part.label);
  return (await scan(input, "texts", options)).map(({ index, rule }) => {
    const place = input.places[index]!;
    return { label: place.path, line: place.line, rule };
  });
}

// The added lines of a patch from diff-tree -p, each with its file and its line number in the
// new version. Each `+++ b/<path>` names the file and each hunk header gives the first new line
// number. Hunks are counted out line by line: an added line ("+") and a context line (" ") each
// take one new line number, so an added line that starts with "++ " is never read as a file
// header, even when a hunk holds context lines. Exported for its tests.
export function addedLines(patch: Buffer): { path: string; line: number; text: Buffer }[] {
  const added: { path: string; line: number; text: Buffer }[] = [];
  let path: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let next = 0;
  for (const line of splitLines(patch)) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line[0] === 0x2b) {
        if (path !== null) added.push({ path, line: next, text: line.subarray(1) });
        next++;
        newLeft--;
      } else if (line[0] === 0x2d) oldLeft--;
      else if (line[0] === 0x20) {
        next++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const text = line.toString("utf8");
    if (text.startsWith("+++ ")) {
      // git ends an unquoted path that holds a space with a tab.
      const name = text.slice(4);
      path = text === "+++ /dev/null" ? null : stripPrefix(name.startsWith('"') ? unquote(name) : name.replace(/\t$/, ""));
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk !== null) {
      oldLeft = Number(hunk[1] ?? 1);
      next = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
    }
  }
  return added;
}

function stripPrefix(path: string): string {
  return path.startsWith("b/") ? path.slice(2) : path;
}

// git writes a path with special characters in double quotes, with C escapes and octal bytes.
function unquote(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const source = Buffer.from(text.slice(1, -1), "utf8");
  const bytes: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== 0x5c) {
      bytes.push(source[i]!);
      continue;
    }
    const octal = /^[0-7]{3}/.exec(source.subarray(i + 1, i + 4).toString("latin1"));
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(escapes[String.fromCharCode(source[i + 1]!)] ?? source[i + 1]!);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// The job files present in the tree, read with one cat-file --batch call.
async function jobFileTexts(repo: Repository, tree: string): Promise<[string, Buffer][]> {
  const input = SCANNED_JOB_FILES.map((name) => `${tree}:.relay/${name}\n`).join("");
  const output = await gitBytes(repo, ["cat-file", "--batch"], input);
  const files: [string, Buffer][] = [];
  let offset = 0;
  for (const name of SCANNED_JOB_FILES) {
    const end = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, end).toString("utf8").split(" ");
    offset = end + 1;
    if (header[1] !== "blob") continue;
    const size = Number(header[2]);
    files.push([name, output.subarray(offset, offset + size)]);
    offset += size + 1;
  }
  return files;
}

// Writes the input, the configuration and an empty ignore file, runs gitleaks on them and returns
// the input line (counted from 0) and rule of each finding, in input order. The temporary files
// are removed whatever happens, also when a signal stops relay. Their names hold the process ID,
// so each scan first removes the files of scans whose process has ended.
async function scan(input: ScanInput, prefix: string, options: ScanOptions): Promise<{ index: number; rule: string }[]> {
  const env = options.env ?? process.env;
  const relayHome = resolveRelayHome(env, resolveHomedir(env));
  const tmp = join(relayHome, "tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  removeStaleScanFiles(tmp);
  const base = join(tmp, `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}`);
  const files = { input: `${base}.scan`, ignore: `${base}.ignore`, report: `${base}.report.json` };
  const config = join(relayHome, "gitleaks.toml");
  const removeFiles = () => {
    for (const file of Object.values(files)) rmSync(file, { force: true });
  };
  const forget = onInterrupt(removeFiles);
  const limit = options.timeoutMs ?? TIME_LIMIT_MS;
  try {
    writePrivate(files.input, Buffer.concat(input.chunks));
    writePrivate(files.ignore, Buffer.alloc(0));
    writePrivate(`${config}.${randomBytes(4).toString("hex")}.tmp`, Buffer.from(CONFIG), config);
    const result = await runGitleaks(
      [
        "stdin", "--config", config, "--gitleaks-ignore-path", files.ignore, "--ignore-gitleaks-allow", "--redact",
        "--no-banner", "--log-level", "error", "--report-format", "json", "--report-path", files.report,
        "--exit-code", String(FINDINGS_EXIT),
      ],
      env,
      files.input,
      tmp,
      limit,
    );
    if (result.timedOut) throw scanFailed(`gitleaks did not finish within ${limit / 1000} seconds, so relay stopped it`);
    if (result.code !== 0 && result.code !== FINDINGS_EXIT) throw scanFailed(firstLine(result.stderr) ?? `gitleaks exited with code ${result.code}`);
    const findings = readReport(files.report, input.places.length);
    if ((result.code === 0) !== (findings.length === 0)) throw scanFailed("gitleaks gave an exit code that does not match its report");
    return findings.sort((a, b) => a.index - b.index);
  } finally {
    removeFiles();
    forget();
  }
}

// Removes the scan files of processes that no longer run, such as a scan stopped by SIGKILL.
function removeStaleScanFiles(tmp: string): void {
  for (const name of readdirSync(tmp)) {
    const match = /^.+-(\d+)-[0-9a-f]{8}\.(scan|ignore|report\.json)$/.exec(name);
    if (match !== null && !isRunning(Number(match[1]))) rmSync(join(tmp, name), { force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
}

// Creates a file only the person can read. With `renameTo`, the file is then moved over that path,
// so a scan running at the same time never reads half of it.
function writePrivate(path: string, bytes: Buffer, renameTo?: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  if (renameTo !== undefined) renameSync(path, renameTo);
}

function readReport(path: string, lines: number): { index: number; rule: string }[] {
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(path, "utf8"), (key, value) => (["Secret", "Match", "Line"].includes(key) ? undefined : value));
  } catch {
    throw scanFailed("relay could not read the gitleaks report");
  }
  if (!Array.isArray(report)) throw scanFailed("relay could not read the gitleaks report");
  return report.map((item: { RuleID?: unknown; StartLine?: unknown }) => {
    const line = item.StartLine;
    if (typeof item.RuleID !== "string" || !Number.isSafeInteger(line) || (line as number) < 1 || (line as number) > lines) {
      throw scanFailed("relay could not read the gitleaks report");
    }
    return { index: (line as number) - 1, rule: item.RuleID };
  });
}

function scanFailed(reason: string): CommandError {
  return new CommandError(ExitCode.Failed, [`The secret scan did not finish: ${printable(reason.replace(/\.$/, ""))}. Nothing was saved.`]);
}

// gitleaks writes its errors as colored log lines, such as "8:42AM FTL <message>".
function firstLine(stderr: string): string | undefined {
  const line = stderr
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((text) => text.replace(/^\d{1,2}:\d{2}(AM|PM) [A-Z]{3} /, "").trim())
    .find((text) => text !== "");
  return line;
}

// Runs gitleaks (RELAY_GITLEAKS, or gitleaks on PATH) without the variables that would let it load
// another configuration. A program that cannot be started counts as missing.
async function runGitleaks(
  args: string[],
  env: Env,
  stdinFile: string | undefined,
  cwd: string | undefined,
  limitMs: number,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name !== "GITLEAKS_CONFIG" && name !== "GITLEAKS_CONFIG_TOML") childEnv[name] = value;
  }
  const program = env.RELAY_GITLEAKS || "gitleaks";
  // A relative path is resolved against the folder relay started in, because the scan runs
  // gitleaks from RELAY_HOME/tmp.
  const path = program.includes("/") ? resolve(program) : Bun.which(program, { PATH: env.PATH ?? "" });
  if (path === null) throw missing();
  let child;
  try {
    child = Bun.spawn([path, ...args], {
      cwd,
      env: childEnv,
      stdin: stdinFile === undefined ? "ignore" : Bun.file(stdinFile),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw missing();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, limitMs);
  const forget = onInterrupt(() => child.kill("SIGKILL"));
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    forget();
  }
}

async function gitBytes(repo: Repository, args: string[], input?: string): Promise<Buffer> {
  const result = await git(repo, args, input === undefined ? {} : { input });
  if (result.code !== 0) throw new Error(`relay could not read the checkpoint for the secret scan: ${result.stderr.trim()}`);
  return Buffer.from(result.stdout);
}

async function gitText(repo: Repository, args: string[]): Promise<string> {
  return (await gitBytes(repo, args)).toString("utf8");
}

function splitLines(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let end = bytes.indexOf(0x0a); end !== -1; end = bytes.indexOf(0x0a, start)) {
    lines.push(bytes.subarray(start, end));
    start = end + 1;
  }
  lines.push(bytes.subarray(start));
  return lines;
}
