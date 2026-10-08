// Reads .relay/verify.md, where the next agent records whether the previous agent's claims hold
// (add-relay-switch, design decision 13): a Markdown table with the columns Claim, Holds and
// Evidence. relay reads it from the work checkpoint and counts the rows by their Holds cell.
import { git } from "../git/run";
import type { Repository } from "../git/repo";

export interface Verification {
  rows: number;
  yes: number;
  no: number;
  unclear: number;
}

// The file's text in the checkpoint, or null when the checkpoint has no .relay/verify.md.
export async function readVerifyFile(repo: Repository, checkpoint: string): Promise<string | null> {
  const result = await git(repo, ["cat-file", "blob", `${checkpoint}:.relay/verify.md`]);
  return result.code === 0 ? new TextDecoder().decode(result.stdout) : null;
}

// Counts the rows of the first table with a Holds column. "yes" and "no" count as such, in any
// case; every other value counts as unclear. A file without such a table has 0 rows.
export function countVerification(text: string): Verification {
  const counts: Verification = { rows: 0, yes: 0, no: 0, unclear: 0 };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = cells(lines[i]!);
    const holds = header?.findIndex((cell) => cell.toLowerCase() === "holds") ?? -1;
    if (holds === -1 || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) continue;
    for (const line of lines.slice(i + 2)) {
      const row = cells(line);
      if (row === null) break;
      const value = (row[holds] ?? "").toLowerCase();
      counts.rows++;
      if (value === "yes") counts.yes++;
      else if (value === "no") counts.no++;
      else counts.unclear++;
    }
    break;
  }
  return counts;
}

// The cells of a table row, or null when the line is not one.
function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim().replace(/^\*\*(.*)\*\*$/, "$1").replace(/^`(.*)`$/, "$1"));
}
