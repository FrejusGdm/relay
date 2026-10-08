// Shared steps for the end-to-end switch tests (design decision 26): the relay binary as a child
// process, fake-claude and fake-codex, the real gitleaks, a scratch repository with a job, and a
// `bun` on PATH whose `bun test` prints a recorded result, so the job's check gives known counts.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startAccountRecord } from "../../src/accounts/record";
import { policyOf } from "../../src/policies/load";
import { personState } from "../helpers/job";
import type { RepoState } from "../helpers/invariants";
import { requireGitleaks } from "../helpers/secrets";
import { switchFixture, type SwitchFixture } from "../handoff/switch-helpers";

export const ACCOUNTS = '[accounts."claude:personal"]\n\n[accounts."codex:personal"]\n';

export interface E2eFixture extends SwitchFixture {
  before: RepoState;
}

// `bunTest` is what the `bun test` check prints and its exit code.
export async function e2eFixture(options: { allow?: string[]; accounts?: string; extra?: string; bunTest?: { output: string; code: number } } = {}): Promise<E2eFixture> {
  requireGitleaks();
  const fixture = await switchFixture({ accounts: options.accounts ?? ACCOUNTS, allow: options.allow ?? ["claude:personal", "codex:personal"], extra: options.extra });
  for (const [provider, name] of [["claude", "personal"], ["claude", "work"], ["codex", "personal"]] as const) {
    startAccountRecord(fixture.relayHome, { id: `${provider}:${name}`, provider, name }, { policy_checked_on_seen: policyOf(provider).checkedOn });
  }
  const bin = mkdtempSync(join(tmpdir(), "relay-bun-"));
  const bunTest = options.bunTest ?? { output: "auth/google.test.ts:\n(fail) refreshes an expired token [12.00ms]\n 231 pass\n 1 fail\n", code: 1 };
  writeFileSync(join(bin, "bun-test-output.txt"), bunTest.output);
  // Only "bun test" is recorded; every other use of bun, such as the fakes' #!/usr/bin/env bun,
  // reaches the real program.
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nif [ "$1" = test ]; then cat '${join(bin, "bun-test-output.txt")}'; exit ${bunTest.code}; fi\nexec '${process.execPath}' "$@"\n`);
  chmodSync(join(bin, "bun"), 0o755);
  Object.assign(fixture.env, { RELAY_GITLEAKS: "", PATH: `${bin}${delimiter}${process.env.PATH}` });
  return { ...fixture, before: personState(fixture.scratch.repo) };
}

// The person's branches, tags, stash, reflogs, index and files are as they were, apart from the
// files that the scenarios told the fake agents to write.
export function expectPersonUnchanged(fixture: E2eFixture, written: string[]): void {
  const after = personState(fixture.scratch.repo);
  const { files: filesBefore, status: _statusBefore, ...gitBefore } = fixture.before;
  const { files: filesAfter, status: _statusAfter, ...gitAfter } = after;
  if (JSON.stringify(gitAfter) !== JSON.stringify(gitBefore)) throw new Error(`git state changed: ${JSON.stringify({ gitBefore, gitAfter })}`);
  const kept = Object.fromEntries(Object.entries(filesAfter).filter(([path]) => !written.includes(path)));
  const expected = Object.fromEntries(Object.entries(filesBefore).filter(([path]) => !written.includes(path)));
  if (JSON.stringify(kept) !== JSON.stringify(expected)) throw new Error("the person's files changed");
}

// Replaces what differs from run to run (the job ID, commits, times, folders) with fixed words, so
// a file can be compared with a golden file.
export function normalize(text: string, fixture: SwitchFixture): string {
  return text
    .replaceAll(fixture.scratch.repo, "/project")
    .replaceAll(fixture.jobId, "3f9a2c1d")
    .replace(/relay-untrusted-notes-[0-9a-f]{8}/g, "relay-untrusted-notes-5b9e04c1")
    .replace(/\b[0-9a-f]{40}\b/g, "<commit>")
    .replace(/\b[0-9a-f]{6,12}\b/g, "<id>")
    .replace(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/g, "<date> <time> UTC")
    .replace(/\b\d\d:\d\d\b/g, "<time>")
    .replace(/\(\d+ minutes?\)/g, "(<n> minutes)")
    .replace(/\| \d+ s \|/g, "| <n> s |");
}

export function golden(name: string, text: string): string {
  const path = join(import.meta.dir, "..", "fixtures", "e2e", name);
  if (process.env.RELAY_WRITE_GOLDEN === "1") {
    mkdirSync(join(import.meta.dir, "..", "fixtures", "e2e"), { recursive: true });
    writeFileSync(path, text);
  }
  return readFileSync(path, "utf8");
}
