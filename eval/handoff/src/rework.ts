// Rework (add-handoff-evaluation design decision 7): the lines the first agent added before the
// handoff that the next agent removed or replaced afterwards. relay's job files in .relay/ are
// not code, so they are left out.
import { git } from "./git.ts";

export interface Rework {
  lines_added_before: number;
  lines_reverted: number;
  rework_ratio: number | null;
  files_reworked: string[];
}

type Ranges = Map<string, [number, number][]>;

function unquote(path: string): string {
  return path.startsWith('"') ? JSON.parse(path) as string : path;
}

// Line ranges per file from `git diff --unified=0`: with side "new", the added lines in the new
// version, keyed by the new path; with side "old", the removed lines in the old version, keyed by
// the old path. A deleted file is one hunk that removes all its lines.
function ranges(diff: string, side: "old" | "new"): Ranges {
  const result: Ranges = new Map();
  let oldPath: string | null = null;
  let newPath: string | null = null;
  // The --- and +++ lines are file headers only before a file's first hunk; inside a hunk they are
  // removed or added lines that start with -- or ++.
  let header = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = null;
      newPath = null;
      header = true;
    } else if (header && line.startsWith("--- ")) {
      oldPath = line === "--- /dev/null" ? null : unquote(line.slice(4)).replace(/^a\//, "");
    } else if (header && line.startsWith("+++ ")) {
      newPath = line === "+++ /dev/null" ? null : unquote(line.slice(4)).replace(/^b\//, "");
    } else if (line.startsWith("@@ ")) {
      header = false;
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      const path = side === "new" ? newPath : oldPath;
      if (!match || path === null) continue;
      const start = Number(side === "new" ? match[3] : match[1]);
      const count = Number((side === "new" ? match[4] : match[2]) ?? "1");
      if (count === 0) continue;
      const list = result.get(path) ?? [];
      list.push([start, start + count - 1]);
      result.set(path, list);
    }
  }
  return result;
}

async function diff(repo: string, from: string, to: string): Promise<string> {
  return (await git(repo, [
    "-c", "core.quotePath=false", "diff", "--unified=0", "--no-renames", "--no-color", "--no-ext-diff",
    from, to, "--", ".", ":(exclude).relay",
  ])).stdout;
}

export async function measureRework(repo: string, base: string, handoff: string, final: string): Promise<Rework> {
  const added = ranges(await diff(repo, base, handoff), "new");
  const removed = ranges(await diff(repo, handoff, final), "old");
  let linesAdded = 0;
  let linesReverted = 0;
  const files: string[] = [];
  for (const [path, list] of added) {
    let overlap = 0;
    for (const [start, end] of list) {
      linesAdded += end - start + 1;
      for (const [from, to] of removed.get(path) ?? []) overlap += Math.max(0, Math.min(end, to) - Math.max(start, from) + 1);
    }
    linesReverted += overlap;
    if (overlap > 0) files.push(path);
  }
  return {
    lines_added_before: linesAdded,
    lines_reverted: linesReverted,
    rework_ratio: linesAdded === 0 ? null : Math.round((linesReverted / linesAdded) * 1000) / 1000,
    files_reworked: files.sort(),
  };
}
