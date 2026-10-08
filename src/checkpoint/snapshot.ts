// Builds the tree of a checkpoint (design.md decisions 3, 5 and 7). relay copies the person's
// index to a temporary file and runs every git command that writes an index on that copy, so the
// person's index, branch and files are never written. The tree holds the working-tree version of
// every tracked file and every untracked file git does not ignore, plus the job files in .relay/.
import { randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";
import { onInterrupt } from "../core/cleanup";
import type { Repository } from "../git/repo";
import { git } from "../git/run";
import { isJobId } from "../job/id";
import { JOB_FILES, VERIFY_FILE } from "../job/names";
import { looksSecret } from "../secrets/names";
import { gitFailed } from "./commit";

// A file larger than the limit, or an untracked folder that is a git repository of its own, which
// git would store only as a pointer to a commit (or not at all, when it has no commit yet).
export type LeftOutFile = { path: string; reason: "size"; bytes: number } | { path: string; reason: "repository" };

export interface Snapshot {
  tree: string;
  // A tracked file left out keeps the version in the person's index.
  leftOut: LeftOutFile[];
  // Untracked files whose names suggest secrets and that the person has not approved. They are
  // not in the tree.
  secretLike: string[];
  // Untracked files whose names suggest secrets and that the person approved. They are in the tree.
  approvedSecretLike: string[];
}

const decoder = new TextDecoder();
// Paths stay as git's bytes for the file system and the pathspec file, so a name that is not
// valid UTF-8 is still found; they are decoded only to compare and to show.
const show = (path: Buffer) => path.toString("utf8");

export async function buildSnapshotTree(
  repo: Repository,
  options: { jobId: string; relayHome: string; maxFileBytes: number; approved: string[] },
): Promise<Snapshot> {
  if (!isJobId(options.jobId)) throw new Error(`relay refused to use the job ID ${JSON.stringify(options.jobId)} in a path.`);
  const tmpDir = join(options.relayHome, "tmp");
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const base = join(tmpDir, `${options.jobId}-${randomBytes(4).toString("hex")}`);
  const index = `${base}.index`;
  const pathspec = `${base}.pathspec`;
  const removeFiles = () => {
    for (const file of [index, `${index}.lock`, pathspec]) rmSync(file, { force: true });
  };
  // The files are removed also when a signal stops relay.
  const forget = onInterrupt(removeFiles);
  try {
    // A plain copy keeps git's cached file times, so git add does not read every file again. A
    // repository without commits may have no index yet; git treats a missing index as empty.
    const original = statSync(repo.indexPath, { bigint: true, throwIfNoEntry: false });
    if (original !== undefined) {
      copyFileSync(repo.indexPath, index, constants.COPYFILE_EXCL);
      // git re-reads a file changed in the same second as the index was written only when the index
      // is not newer than the file. The copy gets the original's time, rounded down to the second,
      // so a change made just after the person's last git add is still seen.
      const seconds = Number(original.mtimeNs / 1_000_000_000n);
      utimesSync(index, seconds, seconds);
    }
    const withIndex = { indexFile: index };

    const untracked = await listPaths(repo, ["ls-files", "-z", "--others", "--exclude-standard"], withIndex);
    const modified = await listPaths(repo, ["ls-files", "-z", "--modified"], withIndex);
    const untrackedNames = new Set(untracked.map((path) => path.toString("latin1")));
    const approved = new Set(options.approved);
    const leftOut: LeftOutFile[] = [];
    const secretLike: string[] = [];
    const approvedSecretLike: string[] = [];
    const excluded: Buffer[] = [];
    const seen = new Set<string>();
    for (const raw of [...untracked, ...modified]) {
      const key = raw.toString("latin1");
      const path = show(raw);
      if (seen.has(key) || path === ".relay" || path.startsWith(".relay/")) continue;
      seen.add(key);
      // git lists an untracked folder that holds a repository of its own as "<folder>/".
      if (path.endsWith("/")) {
        leftOut.push({ path, reason: "repository" });
        excluded.push(raw.subarray(0, raw.length - 1));
        continue;
      }
      const stat = lstatSync(Buffer.concat([Buffer.from(`${repo.worktreeRoot}/`), raw]), { throwIfNoEntry: false });
      if (stat?.isFile() && stat.size > options.maxFileBytes) {
        leftOut.push({ path, reason: "size", bytes: stat.size });
        excluded.push(raw);
      } else if (untrackedNames.has(key) && looksSecret(path)) {
        if (approved.has(path)) approvedSecretLike.push(path);
        else {
          secretLike.push(path);
          excluded.push(raw);
        }
      }
    }

    // git add refuses a pathspec that names an ignored path, so .relay is only excluded here when
    // it is not ignored. Its entries are replaced below either way.
    if (untracked.some((path) => show(path).startsWith(".relay/"))) excluded.push(Buffer.from(".relay"));
    const entries = [Buffer.from("."), ...excluded.map((path) => Buffer.concat([Buffer.from(":(exclude,literal)"), path]))];
    writePrivate(pathspec, Buffer.concat(entries.flatMap((entry) => [entry, Buffer.from([0])])));
    // --sparse: in a sparse checkout, git add otherwise refuses paths outside the sparse
    // definition. Entries git keeps out of the working tree (skip-worktree) stay as they are.
    await run(repo, ["add", "-A", "--sparse", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"], withIndex);

    // Only the job files are stored. A .relay/ entry that came with the copied index, because the
    // person once committed one, is removed first.
    const indexed = await listPaths(repo, ["ls-files", "-z", "--cached", "--", ".relay"], withIndex);
    if (indexed.length > 0) {
      const input = Buffer.concat(indexed.flatMap((path) => [path, Buffer.from([0])]));
      await run(repo, ["update-index", "--force-remove", "-z", "--stdin"], { ...withIndex, input });
    }
    const jobFiles = [...JOB_FILES, VERIFY_FILE]
      .map((name) => `.relay/${name}`)
      .filter((path) => {
        const stat = lstatSync(join(repo.worktreeRoot, path), { throwIfNoEntry: false });
        return stat !== undefined && !stat.isDirectory();
      });
    // -f because /.relay/ is in info/exclude, and --sparse because .relay/ is outside the sparse
    // definition of a cone-mode sparse checkout.
    if (jobFiles.length > 0) await run(repo, ["add", "-f", "--sparse", "--", ...jobFiles], withIndex);

    const tree = decoder.decode((await run(repo, ["write-tree"], withIndex)).stdout).trim();
    return { tree, leftOut, secretLike, approvedSecretLike };
  } finally {
    removeFiles();
    forget();
  }
}

async function run(
  repo: Repository,
  args: string[],
  options: { indexFile: string; input?: Uint8Array },
): Promise<{ stdout: Uint8Array }> {
  const result = await git(repo, args, options);
  if (result.code !== 0) throw gitFailed(`relay could not build the checkpoint: git ${args[0]} failed`, result.stderr);
  return result;
}

// The NUL-separated paths git printed, as bytes.
async function listPaths(repo: Repository, args: string[], options: { indexFile: string }): Promise<Buffer[]> {
  const stdout = Buffer.from((await run(repo, args, options)).stdout);
  const paths: Buffer[] = [];
  for (let start = 0, end = stdout.indexOf(0); end !== -1; start = end + 1, end = stdout.indexOf(0, start)) {
    if (end > start) paths.push(stdout.subarray(start, end));
  }
  return paths;
}

function writePrivate(path: string, text: Uint8Array): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
