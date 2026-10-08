// The scratch repository of one run (add-handoff-evaluation design decision 9). It is built from
// the committed starting repository, outside the relay repository, so an agent never sees the
// acceptance tests, the reference solution or a local file git ignores.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { exportTree, git } from "./git.ts";
import { checkFixturesClean } from "./guards.ts";

export const PERSON_NOTE = "Uncommitted note from the person.";

function fixturePath(task: string): string {
  return `eval/handoff/tasks/${task}`;
}

// The fixture's tree in the relay repository, or `dirty` when it has uncommitted or ignored files
// and --allow-dirty-fixtures was given.
export async function fixtureVersion(repoRoot: string, task: string, allowDirty: boolean): Promise<string> {
  if (!allowDirty) await checkFixturesClean(repoRoot, [task]);
  else {
    const status = await git(repoRoot, ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", fixturePath(task)]);
    if (status.stdout.trim() !== "") return "dirty";
  }
  return (await git(repoRoot, ["rev-parse", `HEAD:${fixturePath(task)}`])).stdout.trim();
}

// Creates <workDir>/repo from the fixture's .start/ folder with one commit on main, then adds an
// uncommitted line to NOTES.md that stands for the person's own work. Returns the base commit.
export async function createScratchRepo(options: {
  repoRoot: string;
  task: string;
  taskVersion: string;
  workDir: string;
  allowDirty: boolean;
}): Promise<{ repo: string; baseSha: string }> {
  const { repoRoot, workDir } = options;
  const repo = join(workDir, "repo");
  const start = `${fixturePath(options.task)}/.start`;
  if (options.allowDirty) {
    mkdirSync(repo, { recursive: true });
    const listed = await git(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", start]);
    for (const path of listed.stdout.split("\0").filter(Boolean)) {
      if (!existsSync(join(repoRoot, path))) continue;
      const target = join(repo, relative(start, path));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(repoRoot, path), target);
    }
  } else {
    await exportTree(repoRoot, `HEAD:${start}`, repo);
  }
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", `fixture ${options.task} at ${options.taskVersion}`]);
  const notes = join(repo, "NOTES.md");
  const text = existsSync(notes) ? readFileSync(notes, "utf8") : "";
  appendFileSync(notes, `${text === "" || text.endsWith("\n") ? "" : "\n"}${PERSON_NOTE}\n`);
  return { repo, baseSha: (await git(repo, ["rev-parse", "main"])).stdout.trim() };
}

// relay must work in the scratch repository itself, not in a repository around it.
export async function checkTopLevel(repo: string): Promise<void> {
  const top = (await git(repo, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (realpathSync(top) !== realpathSync(repo)) {
    throw new Error(`git says the scratch repository ${repo} belongs to ${top}.`);
  }
}
