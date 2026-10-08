// Files that instruct agents (add-relay-switch, design decision 17; docs/research/security.md
// section 5, recommendations 2 and 3). When the outgoing agent changed one of them, relay lists them
// and asks before the next agent starts, and it warns about invisible characters in them. relay
// never changes these files.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join, posix } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { gitFailed } from "../checkpoint/commit";
import { printable } from "../core/quote";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import { replaceInvisible } from "../text/invisible";
import type { Provider } from "../adapters/providers";
import { displayName } from "./account";
import { isYes, type AnswerHow, type Asker } from "./ask";

// The names of files that instruct agents. They match in any case, because a Mac's file system
// ignores case, so an agent could otherwise add claude.md or .MCP.json without relay asking.
const NAMES = [
  "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md", ".claude", ".mcp.json", ".codex", ".cursor", ".agents",
  ".github/copilot-instructions.md",
];
const WATCHED = [...NAMES.map((name) => `:(icase,literal)${name}`), ":(glob,icase)**/AGENTS.md", ":(glob,icase)**/CLAUDE.md"];
// How many links in a row relay follows from a watched file to the file it points to.
const LINK_DEPTH = 5;
// The most relay reads of one file to look for invisible characters.
const READ_LIMIT = 1024 * 1024;
const decoder = new TextDecoder();

// The watched paths that differ between two trees or commits, in the order of the watched list.
// A watched file that is a symbolic link also brings in the file it points to inside the project,
// so a change made through the link is found. A link that points outside the project is always
// listed, because relay cannot compare what it points to.
export async function changedInstructionFiles(repo: Repository, from: string, to: string): Promise<string[]> {
  const { targets, outside } = await linkTargets(repo, [from, to]);
  const pathspecs = [...WATCHED, ...targets.map((target) => `:(literal)${target}`)];
  const result = await git(repo, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", from, to, "--", ...pathspecs]);
  if (result.code !== 0) throw gitFailed("relay could not compare the files that instruct agents", result.stderr);
  const paths = new Set(decoder.decode(result.stdout).split("\0").filter((path) => path !== ""));
  for (const link of outside) paths.add(link);
  const rank = (path: string) => {
    const lower = path.toLowerCase();
    const index = NAMES.findIndex((name) => lower === name.toLowerCase() || lower.startsWith(`${name.toLowerCase()}/`));
    return index === -1 ? NAMES.length : index;
  };
  return [...paths].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

// The files that watched symbolic links in the trees point to: inside the project, followed up to
// five links deep, or outside it.
async function linkTargets(repo: Repository, trees: string[]): Promise<{ targets: string[]; outside: string[] }> {
  const empty = await gitText(repo, ["hash-object", "-t", "tree", "/dev/null"]);
  const targets = new Set<string>();
  const outside = new Set<string>();
  let pathspecs = WATCHED;
  for (let depth = 0; depth < LINK_DEPTH && pathspecs.length > 0; depth++) {
    const found: string[] = [];
    for (const tree of trees) {
      const raw = await gitText(repo, ["diff-tree", "-r", "-z", "--no-renames", "--raw", empty.trim(), tree, "--", ...pathspecs]);
      const fields = raw.split("\0");
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const [, mode, , sha] = fields[i]!.split(" ");
        if (mode !== "120000" || sha === undefined) continue;
        const link = fields[i + 1]!;
        const target = await gitText(repo, ["cat-file", "blob", sha]);
        const resolved = posix.normalize(posix.join(posix.dirname(link), target));
        if (target.startsWith("/") || resolved === ".." || resolved.startsWith("../")) outside.add(link);
        else if (!targets.has(resolved)) {
          targets.add(resolved);
          found.push(resolved);
        }
      }
    }
    pathspecs = found.map((target) => `:(literal)${target}`);
  }
  return { targets: [...targets], outside: [...outside] };
}

async function gitText(repo: Repository, args: string[]): Promise<string> {
  const result = await git(repo, args);
  if (result.code !== 0) throw gitFailed("relay could not read the files that instruct agents", result.stderr);
  return decoder.decode(result.stdout);
}

// One warning for each file, among `paths`, that holds invisible characters in the working tree.
function invisibleWarnings(worktreeRoot: string, paths: string[]): string[] {
  return paths.flatMap((path) => {
    const text = readSmall(join(worktreeRoot, path));
    if (text === null) return [];
    let count = 0;
    let firstLine = 0;
    text.split("\n").forEach((line, index) => {
      replaceInvisible(line, () => {
        count++;
        if (firstLine === 0) firstLine = index + 1;
        return "";
      });
    });
    if (count === 0) return [];
    const characters = count === 1 ? "1 invisible character" : `${count} invisible characters`;
    return [`${printable(path)} contains ${characters} (first on line ${firstLine}). relay does not change this file.`];
  });
}

interface InstructionQuestion {
  asker: Asker;
  from: Provider;
  to: { id: string; provider: Provider };
  // The outgoing worker's start checkpoint, which the review command compares with.
  startCheckpoint: string;
  paths: string[];
  worktreeRoot: string;
  // The answer to give when the person says no: the agent may still run, or be stopped already.
  refusal: string[];
}

// Asks whether the next agent may start with the changed files. Returns how the person answered;
// throws exit code 7 without an answer or on a "no".
export async function confirmInstructionFiles(question: InstructionQuestion): Promise<AnswerHow> {
  const { asker } = question;
  const fromName = displayName(question.from);
  const preset = asker.preset?.instructionFiles;
  if (preset !== undefined && preset.paths.join("\0") === question.paths.join("\0")) return preset.how;
  if (asker.yes) return "flag";
  if (!asker.terminal) {
    throw new CommandError(ExitCode.NeedsPerson, [
      `${fromName} changed files that tell agents what to do. Review them, then run relay switch ${question.to.id} in a terminal, or add --yes.`,
    ]);
  }
  const shown = question.paths.map(printable);
  asker.say(`${fromName} changed files that tell agents what to do:`);
  for (const path of shown) asker.say(`  ${path}`);
  asker.say(`Review them with: git diff ${question.startCheckpoint.slice(0, 7)} -- ${shown.map(shellWord).join(" ")}`);
  for (const warning of invisibleWarnings(question.worktreeRoot, question.paths)) asker.say(warning);
  if (isYes(await asker.ask(`Start ${displayName(question.to.provider)} with these files? [y/N]`))) return "terminal";
  throw new CommandError(ExitCode.NeedsPerson, question.refusal);
}

function shellWord(path: string): string {
  return /^[A-Za-z0-9._/@+-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

// The start of a regular file, or null when there is none. A symbolic link is followed, so the
// check reads the text an agent would read; a named pipe or a device is not read.
function readSmall(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(READ_LIMIT);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}
