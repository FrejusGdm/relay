// Files that instruct agents (add-relay-switch, design decision 17; docs/research/security.md
// section 5, recommendations 2 and 3). When the outgoing agent changed one of them, relay lists them
// and asks before the next agent starts, and it warns about invisible characters in them. relay
// never changes these files.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
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

const WATCHED = [
  "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md", ".claude", ".mcp.json", ".codex", ".cursor", ".agents",
  ".github/copilot-instructions.md", ":(glob)**/AGENTS.md", ":(glob)**/CLAUDE.md",
];
// The most relay reads of one file to look for invisible characters.
const READ_LIMIT = 1024 * 1024;

// The watched paths that differ between two trees or commits, in the order of the watched list.
export async function changedInstructionFiles(repo: Repository, from: string, to: string): Promise<string[]> {
  const result = await git(repo, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", from, to, "--", ...WATCHED]);
  if (result.code !== 0) throw gitFailed("relay could not compare the files that instruct agents", result.stderr);
  const paths = Buffer.from(result.stdout).toString("utf8").split("\0").filter((path) => path !== "");
  const rank = (path: string) => {
    const index = WATCHED.findIndex((watched) => path === watched || path.startsWith(`${watched}/`));
    return index === -1 ? WATCHED.length : index;
  };
  return paths.sort((a, b) => rank(a) - rank(b));
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

// The start of a regular file, without following a symbolic link, or null when there is none.
function readSmall(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
