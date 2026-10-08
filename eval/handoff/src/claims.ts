// Claims found false (add-handoff-evaluation design decision 7): relay's own mismatches from the
// handoff event, plus the rows of .relay/verify.md whose Holds column says no. The next agent
// writes verify.md as a Markdown table with the columns Claim, Holds and Evidence.

interface Claims {
  verify_written: boolean;
  relay_mismatches: number;
  claims_found_false: number;
  claims_unverified: number;
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function clean(cell: string): string {
  return cell.replace(/[*_`]/g, "").trim().toLowerCase();
}

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

// The values of the Holds column, or null when the text has no table with the three columns.
export function readVerify(text: string | null): string[] | null {
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index + 1 < lines.length; index++) {
    if (!lines[index]!.includes("|")) continue;
    const header = cells(lines[index]!).map(clean);
    const holds = header.indexOf("holds");
    if (!header.includes("claim") || holds === -1 || !header.includes("evidence") || !SEPARATOR.test(lines[index + 1]!)) continue;
    const values: string[] = [];
    for (const line of lines.slice(index + 2)) {
      if (!line.trim().startsWith("|")) break;
      values.push(clean(cells(line)[holds] ?? ""));
    }
    return values;
  }
  return null;
}

// A row that says neither yes nor no counts as unverified.
export function countClaims(verifyText: string | null, mismatches: unknown): Claims {
  const holds = readVerify(verifyText);
  const relayMismatches = Array.isArray(mismatches) ? mismatches.length : 0;
  return {
    verify_written: holds !== null,
    relay_mismatches: relayMismatches,
    claims_found_false: relayMismatches + (holds ?? []).filter((value) => value === "no").length,
    claims_unverified: (holds ?? []).filter((value) => value !== "yes" && value !== "no").length,
  };
}
