// The only module that starts git (design.md decision 8, docs/git-safety.md). Every call gets the
// overrides below, an environment without the parent's GIT_ variables, closed standard input and a
// time limit, and only the commands and arguments relay needs are allowed.
import { appendFileSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Every hook event in githooks(5). git 2.54 and newer also run hooks defined in configuration
// (hook.<name>.command), which core.hooksPath does not stop; hook.<event>.enabled=false does.
const HOOK_EVENTS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
  "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
  "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist",
  "p4-pre-submit", "post-index-change",
];

// Command-line settings take precedence over every configuration file git reads.
const OVERRIDES = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "core.quotePath=false",
  "-c", "diff.external=",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "commit.gpgSign=false",
  "-c", "log.showSignature=false",
  // Signature checks, for example the %G? format code, run the signing program; "false" is a
  // program that does nothing.
  "-c", "gpg.program=false",
  "-c", "gpg.ssh.program=false",
  "-c", "gpg.x509.program=false",
  // No reflog for relay's refs: a linked logs/refs/relay folder would otherwise let git append to
  // a branch's reflog.
  "-c", "core.logAllRefUpdates=false",
  // A split index writes a sharedindex file into the person's .git folder, even for a
  // temporary index.
  "-c", "core.splitIndex=false",
  "-c", "credential.helper=",
  "-c", "protocol.allow=never",
  "-c", "color.ui=false",
  ...HOOK_EVENTS.flatMap((event) => ["-c", `hook.${event}.enabled=false`]),
];

// After this time relay stops the git process it started, with everything that process started.
const TIME_LIMIT_MS = 120_000;

interface GitOptions {
  // Bytes for standard input. Without it, standard input is closed.
  input?: string | Uint8Array;
  // A temporary index file, passed as GIT_INDEX_FILE. Never the person's index.
  indexFile?: string;
  // Author and committer for commit-tree, passed as GIT_AUTHOR_* and GIT_COMMITTER_*.
  identity?: { name: string; email: string };
  timeoutMs?: number;
}

interface GitResult {
  stdout: Uint8Array;
  stderr: string;
  code: number;
}

type Repo = string | { worktreeRoot: string };

// `repo` is a repository from openRepository, or for discovery the folder to start from.
export async function git(repo: Repo, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const finalArgs = checkArgs(args, options);
  if (args[0] === "update-ref") await refuseLinkedRefFolders(repo, args, options.input);
  return await start(repo, finalArgs, options);
}

async function start(repo: Repo, args: string[], options: GitOptions): Promise<GitResult> {
  const argv = ["git", ...OVERRIDES, ...args];
  record(argv);
  // In its own process group, so a time-out also stops the programs git started, such as filters.
  const child = Bun.spawn(argv, {
    detached: true,
    cwd: typeof repo === "string" ? repo : repo.worktreeRoot,
    env: gitEnv(options),
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  liveGroups.add(child.pid);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const limit = options.timeoutMs ?? TIME_LIMIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), limit)));
  try {
    const result = await Promise.race([child.exited, timedOut]);
    if (result === "timeout") {
      signalGroup(child.pid, "SIGKILL");
      await child.exited;
    }
    // A program git started, or one that program left in the background, can outlive git and
    // keep the output pipes open. relay ends the whole group, then reads what git wrote without
    // waiting for pipes that something outside the group still holds.
    await endGroup(child.pid);
    await Promise.race([Promise.all([stdout.done, stderr.done]), Bun.sleep(PIPE_GRACE_MS)]);
    stdout.stop();
    stderr.stop();
    if (result === "timeout") {
      throw new Error(`git ${args[0]} did not finish within ${limit / 1000} seconds, so relay stopped it.`);
    }
    return { stdout: Buffer.concat(stdout.chunks), stderr: Buffer.concat(stderr.chunks).toString("utf8"), code: result };
  } finally {
    clearTimeout(timer);
  }
}

// How long relay waits for the end of git's output once git's process group is gone.
const PIPE_GRACE_MS = 200;

function collect(stream: ReadableStream<Uint8Array>): { chunks: Uint8Array[]; done: Promise<void>; stop(): void } {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) return;
        chunks.push(value);
      }
    } catch {
      // The stream was cancelled by stop().
    }
  })();
  return { chunks, done, stop: () => void reader.cancel().catch(() => {}) };
}

// Ends a git process group: asks what is left in it to stop, waits up to half a second, kills
// the rest, and stops tracking the group once it is empty.
async function endGroup(pid: number): Promise<void> {
  if (signalGroup(pid, 0)) {
    signalGroup(pid, "SIGTERM");
    for (let waited = 0; signalGroup(pid, 0) && waited < 500; waited += 20) await Bun.sleep(20);
    signalGroup(pid, "SIGKILL");
    for (let waited = 0; signalGroup(pid, 0) && waited < 1000; waited += 20) await Bun.sleep(20);
  }
  liveGroups.delete(pid);
}

// Process groups of the git processes relay started, kept until the group is empty. Each git
// process leads its own group, which also holds the programs it started.
const liveGroups = new Set<number>();

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

// Stops every git process relay started that is still running, with the programs it started.
// Because git runs in its own process group, Control-C does not reach it, so relay calls this
// before it exits. It asks each group to stop, waits up to `waitMs`, then kills what is left.
export async function stopGitProcesses(waitMs = 500): Promise<void> {
  const groups = [...liveGroups];
  for (const pid of groups) signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + waitMs;
  while (groups.some((pid) => signalGroup(pid, 0)) && Date.now() < deadline) await Bun.sleep(20);
  for (const pid of groups) signalGroup(pid, "SIGKILL");
}

function refuse(args: string[], reason: string): never {
  throw new Error(`relay refused to run git ${args.join(" ")}: ${reason}`);
}

// Each allowed command has a rule. A rule returns the reason to refuse, or nothing.
type Rule = (rest: string[]) => string | undefined;

// The diff and log commands also get --no-ext-diff and --no-textconv, so no diff program runs.
const NO_DIFF_PROGRAMS = ["--no-ext-diff", "--no-textconv"];

// --text is an option of its own, not a shortened --textconv: git takes an exact name first.
const diffRule: Rule = (rest) =>
  signatureFormat(rest) ?? dangerousOption(rest, ["ext-diff", "textconv", "show-signature"], "", ["text"]);

// The %G format codes (%G?, %GS, %GK and the others) check signatures.
function signatureFormat(rest: string[]): string | undefined {
  const option = optionsOf(rest).find((arg) => arg.includes("%G"));
  return option === undefined ? undefined : `relay does not use signature format codes: ${option}`;
}

// Exactly the commands relay runs in add-checkpoint-engine, add-provider-adapters and
// add-relay-switch. Any other name, including an alias, is refused.
const RULES: Record<string, Rule> = {
  version: (rest) => (rest.length === 0 ? undefined : "relay runs git version without arguments"),
  "rev-parse": () => undefined,
  "symbolic-ref": symbolicRefRule,
  config: configRule,
  status: () => undefined,
  "ls-files": () => undefined,
  "for-each-ref": (rest) =>
    rest.some((arg) => arg.includes("%(signature")) ? "signature fields start a signing program" : undefined,
  "cat-file": (rest) => dangerousOption(rest, ["textconv", "filters"]),
  "rev-list": (rest) => signatureFormat(rest) ?? dangerousOption(rest, ["show-signature"]),
  diff: diffRule,
  "diff-tree": diffRule,
  log: diffRule,
  show: diffRule,
  "hash-object": (rest) => onlyOptions(rest, ["-w", "--stdin", "--no-filters"], ["-t"]),
  add: (rest) => dangerousOption(rest, ["edit", "interactive", "patch"], "eip"),
  "read-tree": (rest) => (rest.length === 1 && !rest[0]!.startsWith("-") ? undefined : "relay reads exactly one tree"),
  "write-tree": (rest) => (rest.length === 0 ? undefined : "relay runs write-tree without arguments"),
  "checkout-index": (rest) =>
    onlyOptions(rest, ["-f", "--force", "-z", "--stdin", "-q", "--quiet", "-u", "--index", "-a", "--all"]),
  "update-index": (rest) =>
    onlyOptions(rest, ["--add", "--remove", "--force-remove", "--cacheinfo", "--index-info", "-z", "--stdin", "--refresh", "-q"]),
  "commit-tree": (rest) => onlyOptions(rest, ["--no-gpg-sign"], ["-p"]),
  "update-ref": () => undefined,
};

// These commands write the index file they work on, so they may only run on a temporary one.
const INDEX_WRITERS = new Set(["add", "read-tree", "update-index", "write-tree", "checkout-index"]);

function checkArgs(args: string[], options: GitOptions): string[] {
  const [command, ...rest] = args;
  // A leading option such as -c, -C or --git-dir is not a command, so it is refused too.
  const rule = command === undefined || !Object.hasOwn(RULES, command) ? undefined : RULES[command];
  if (command === undefined || rule === undefined) refuse(args, "relay does not use this git command");
  if (INDEX_WRITERS.has(command) && options.indexFile === undefined) {
    refuse(args, "this command writes an index, so it needs a temporary index file");
  }
  // --output (or a shortened form of it) makes diff, log and rev-list write to any file.
  const reason = dangerousOption(rest, ["output"]) ?? rule(rest);
  if (reason !== undefined) refuse(args, reason);
  if (command === "update-ref") {
    for (const ref of updateRefTargets(args, options.input)) checkRelayRef(args, ref);
    return ["update-ref", "--no-deref", ...rest];
  }
  return rule === diffRule ? [command, ...NO_DIFF_PROGRAMS, ...rest] : args;
}

// Options before "--".
function optionsOf(rest: string[]): string[] {
  const end = rest.findIndex((arg) => arg === "--" || arg === "--end-of-options");
  return (end === -1 ? rest : rest.slice(0, end)).filter((arg) => arg.startsWith("-") && arg !== "-");
}

// git accepts any unambiguous beginning of a long option, so `--textc` means `--textconv`.
// `shortLetters` lists single-letter options, which may also come bundled, as in `-Ap`.
// `exactNames` are safe options whose full name is also the start of a refused one.
function dangerousOption(rest: string[], longNames: string[], shortLetters = "", exactNames: string[] = []): string | undefined {
  for (const option of optionsOf(rest)) {
    const name = option.slice(2).split("=")[0]!;
    const dangerous = option.startsWith("--")
      ? !exactNames.includes(name) && longNames.some((long) => long.startsWith(name))
      : [...option.slice(1)].some((letter) => shortLetters.includes(letter));
    if (dangerous) return `relay does not use the option ${option}`;
  }
  return undefined;
}

// Allows exactly these options; `withValue` options take the next argument as their value.
function onlyOptions(rest: string[], plain: string[], withValue: string[] = []): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") return undefined;
    if (withValue.includes(arg)) i++;
    else if (arg.startsWith("-") && !plain.includes(arg)) return `relay does not use the option ${arg}`;
  }
  return undefined;
}

// Only `symbolic-ref [-q] [--short] HEAD`, which reads HEAD.
function symbolicRefRule(rest: string[]): string | undefined {
  const ok = rest.at(-1) === "HEAD" && rest.slice(0, -1).every((arg) => arg === "-q" || arg === "--short");
  return ok ? undefined : "relay only reads HEAD, with symbolic-ref [-q] [--short] HEAD";
}

// Only reading: `--get <key>`, `--get-all <key>` or `--list`, with display options and `--file`.
function configRule(rest: string[]): string | undefined {
  const allowed = ["--show-origin", "--show-scope", "-z", "--null", "--name-only", "--includes", "--no-includes",
    "--local", "--global", "--system", "--worktree"];
  let mode: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--get" || arg === "--get-all" || arg === "--list") {
      if (mode !== undefined) return "relay reads one thing per git config call";
      mode = arg;
    } else if (arg === "--file") i++;
    else if (arg.startsWith("-") && !allowed.includes(arg)) return `relay does not use the option ${arg}`;
    else if (!arg.startsWith("-")) positionals.push(arg);
  }
  if (mode === "--list" && positionals.length === 0) return undefined;
  if ((mode === "--get" || mode === "--get-all") && positionals.length === 1) return undefined;
  return "relay only reads git configuration";
}

function checkRelayRef(args: string[], ref: string): void {
  if (!ref.startsWith("refs/relay/") || ref.includes("..")) {
    refuse(args, `relay only writes refs under refs/relay/, not ${ref || "(none)"}`);
  }
}

// The refs an update-ref call writes. Forms relay uses: `update-ref [-m <reason>] [-d] <ref> ...`
// and `update-ref --stdin` with one command per line. The NUL-separated (-z) and quoted forms and
// the symref- and option commands are refused, so every ref relay writes is known here.
function updateRefTargets(args: string[], input: string | Uint8Array | undefined): string[] {
  const rest = args.slice(1);
  const positionals: string[] = [];
  let stdin = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "-m") i++;
    else if (arg === "--stdin") stdin = true;
    else if (arg === "-d" || arg === "--no-deref") continue;
    else if (arg.startsWith("-")) refuse(args, `relay does not use the option ${arg}`);
    else positionals.push(arg);
  }
  if (!stdin) return [positionals[0] ?? ""];
  if (positionals.length > 0) refuse(args, "--stdin takes no other arguments");
  const text = typeof input === "string" ? input : new TextDecoder().decode(input ?? new Uint8Array());
  const refs: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const [verb, ref] = line.split(" ");
    if (verb === "update" || verb === "create" || verb === "delete" || verb === "verify") refs.push(ref ?? "");
    else if (!["start", "prepare", "commit", "abort"].includes(verb!)) {
      refuse(args, `relay does not use the update-ref command ${JSON.stringify(verb)}`);
    }
  }
  return refs;
}

// A symbolic link at refs/, refs/relay/ or below would make git write the ref somewhere else, for
// example over a branch. No folder on the way to the ref, and not the ref file, may be one, and no
// file there may have a second hard link. The same holds for the ref's path under logs/, where
// nothing may exist at all: relay never creates reflogs, but git appends to one that exists, and a
// planted one can be a hard link to the person's index or a branch's reflog.
async function refuseLinkedRefFolders(repo: Repo, args: string[], input: string | Uint8Array | undefined): Promise<void> {
  const where = await start(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {});
  if (where.code !== 0) refuse(args, `git could not find the repository: ${where.stderr.trim()}`);
  const commonDir = new TextDecoder().decode(where.stdout).trim();
  for (const ref of updateRefTargets(args, input)) {
    refuseLinkOnPath(args, commonDir, ref.split("/"));
    refuseLinkOnPath(args, commonDir, ["logs", ...ref.split("/")]);
    if (lstatSync(join(commonDir, "logs", ref), { throwIfNoEntry: false }) !== undefined) {
      refuse(args, `logs/${ref} exists, but relay never keeps a reflog for its refs`);
    }
  }
}

function refuseLinkOnPath(args: string[], commonDir: string, parts: string[]): void {
  for (let depth = 1; depth <= parts.length; depth++) {
    const path = parts.slice(0, depth).join("/");
    const stat = lstatSync(join(commonDir, path), { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) refuse(args, `${path} is a symbolic link`);
    if (!stat.isDirectory() && stat.nlink > 1) refuse(args, `${path} has more than one hard link`);
  }
}

function gitEnv(options: GitOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
  }
  // Without optional locks, read commands such as status never refresh the person's index.
  env.GIT_OPTIONAL_LOCKS = "0";
  // An empty list allows no transport at all, whatever protocol.<name>.allow says.
  env.GIT_ALLOW_PROTOCOL = "";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.LC_ALL = "C";
  // The test guard program test/fixtures/fake-provider/guard-bin/git lets only this child through.
  env.RELAY_GIT_RUNNER = "1";
  if (options.indexFile !== undefined) env.GIT_INDEX_FILE = options.indexFile;
  if (options.identity !== undefined) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = options.identity.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = options.identity.email;
  }
  return env;
}

// Tests read which commands ran. Each watcher gets every argument list started after it began.
const watchers = new Set<string[][]>();

export function watchGitCalls(): { calls: string[][]; stop(): void } {
  const calls: string[][] = [];
  watchers.add(calls);
  return { calls, stop: () => watchers.delete(calls) };
}

function record(argv: string[]): void {
  for (const calls of watchers) calls.push(argv);
  const relayHome = process.env.RELAY_HOME;
  if (process.env.RELAY_TEST_GIT_LOG === "1" && relayHome) {
    const dir = join(relayHome, "logs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, "git-calls.jsonl"), `${JSON.stringify(argv)}\n`, { mode: 0o600 });
  }
}
