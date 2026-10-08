// Compares the outgoing agent's notes with facts relay checked (add-relay-switch, design decision
// 10), by three rules and without a model. Each difference is a sentence written by relay: it holds
// only a check command the person recorded, a path that passed the path test, and relay's results.
import { git } from "../git/run";
import type { Repository } from "../git/repo";
import { displayName } from "./account";
import { resultText, type CheckResult } from "./checks";
import type { ParsedNotes } from "./notes-parse";
import type { Provider } from "../adapters/providers";

export interface Mismatch {
  claim: string;
  found: string;
  kind: "check" | "file_not_changed" | "path_missing";
  sentence: string;
}

const PASS = new Set(["pass", "passes", "passed", "passing", "green", "succeeds", "succeeded"]);
const FAIL = new Set(["fail", "fails", "failed", "failing", "red", "broken"]);

export async function compareClaims(repo: Repository, input: {
  notes: ParsedNotes;
  checks: CheckResult[];
  // The paths that changed between the worker's start checkpoint and the work checkpoint, job files
  // under .relay/ included.
  changedWhileWorking: string[];
  workCheckpoint: string;
  from: Provider;
}): Promise<Mismatch[]> {
  const mismatches: Mismatch[] = [];
  const add = (mismatch: Mismatch) => {
    if (!mismatches.some((known) => known.sentence === mismatch.sentence)) mismatches.push(mismatch);
  };

  for (const claim of input.notes.claims) {
    const line = `${claim.text} ${claim.how}`;
    const words = new Set(line.replace(/`[^`]*`/g, " ").toLowerCase().match(/[a-z]+/g) ?? []);
    const says = [...words].some((word) => PASS.has(word)) ? "passes" : null;
    const denies = [...words].some((word) => FAIL.has(word)) ? "fails" : null;
    if ((says === null) === (denies === null)) continue;
    for (const check of input.checks) {
      if (!line.includes(`\`${check.command}\``)) continue;
      const result = resultText(check);
      if (says !== null && check.outcome !== "passed") {
        add({ kind: "check", claim: `notes say \`${check.command}\` passes`, found: result, sentence: `The notes say \`${check.command}\` passes. relay ran it: ${result}.` });
      } else if (denies !== null && check.outcome === "passed") {
        add({ kind: "check", claim: `notes say \`${check.command}\` fails`, found: result, sentence: `The notes say \`${check.command}\` fails. relay ran it: ${result}.` });
      }
    }
  }

  const changed = new Set(input.changedWhileWorking);
  const name = displayName(input.from);
  for (const line of input.notes.sections["Files touched"] ?? []) {
    const path = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim().replace(/^`(.*)`$/, "$1");
    if (!isPath(path) || changed.has(path)) continue;
    const found = `it did not change while ${name} worked`;
    add({ kind: "file_not_changed", claim: `notes list \`${path}\` as changed`, found, sentence: `The notes list \`${path}\` as changed, but ${found}.` });
  }

  const mentioned = [...(input.notes.sections.Done ?? []), ...(input.notes.sections["Claims to verify"] ?? [])]
    .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]!))
    .filter(isPath);
  const short = input.workCheckpoint.slice(0, 6);
  for (const path of new Set(mentioned)) {
    if (await existsIn(repo, input.workCheckpoint, path)) continue;
    const found = `it does not exist in checkpoint ${short}`;
    add({ kind: "path_missing", claim: `notes mention \`${path}\``, found, sentence: `The notes mention \`${path}\`, which does not exist in checkpoint ${short}.` });
  }
  return mismatches;
}

// A token that looks like a path: plain characters only (letters, digits and . _ / @ + -), a "/"
// or an ending such as ".ts", no "..", not starting with "-", "http" or "/", and at most 120
// characters. Only such tokens go into relay's sentences, so they carry no agent sentence.
function isPath(token: string): boolean {
  return /^[A-Za-z0-9._/@+-]{1,120}$/.test(token) && !token.includes("..")
    && !/^(?:-|http|\/)/.test(token) && (token.includes("/") || /\.[A-Za-z0-9]+$/.test(token));
}

async function existsIn(repo: Repository, commit: string, path: string): Promise<boolean> {
  return (await git(repo, ["cat-file", "-e", `${commit}:${path}`])).code === 0;
}
