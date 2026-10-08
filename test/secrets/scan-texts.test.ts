import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError } from "../../src/cli/errors";
import { scanTexts } from "../../src/secrets/scan";
import { fakeAwsKey, fakeGithubToken, filesContaining, requireGitleaks } from "../helpers/secrets";

const FAKE = join(import.meta.dir, "..", "helpers", "fake-gitleaks.ts");

let root: string;
let relayHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "relay-test-"));
  relayHome = join(root, "relay-home");
  previousHome = process.env.RELAY_HOME;
  process.env.RELAY_HOME = relayHome;
});
afterEach(() => {
  process.env.RELAY_HOME = previousHome;
  for (const name of ["RELAY_GITLEAKS", "FAKE_GITLEAKS_RECORD", "FAKE_GITLEAKS_EXIT", "FAKE_GITLEAKS_STDERR"]) delete process.env[name];
  rmSync(root, { recursive: true, force: true });
});

const tmpFiles = () => (existsSync(join(relayHome, "tmp")) ? readdirSync(join(relayHome, "tmp")) : []);

describe("with the fake scanner", () => {
  beforeEach(() => {
    process.env.RELAY_GITLEAKS = FAKE;
    process.env.FAKE_GITLEAKS_RECORD = join(root, "record.json");
  });

  test("findings carry the label and the line within each part", async () => {
    const findings = await scanTexts([
      { label: "the prompt for Codex", text: "Continue the job.\nFAKE-SECRET:one\n" },
      { label: "Claude Code's handoff notes", text: "a\nb\nFAKE-SECRET:two\nc" },
      { label: "the instructions", text: "FAKE-SECRET:three\n\n\nFAKE-SECRET:four\n" },
    ]);
    expect(findings).toEqual([
      { label: "the prompt for Codex", line: 2, rule: "one" },
      { label: "Claude Code's handoff notes", line: 3, rule: "two" },
      { label: "the instructions", line: 1, rule: "three" },
      { label: "the instructions", line: 4, rule: "four" },
    ]);
    const record = JSON.parse(readFileSync(join(root, "record.json"), "utf8"));
    expect(record.input).toBe("Continue the job.\nFAKE-SECRET:one\na\nb\nFAKE-SECRET:two\nc\nFAKE-SECRET:three\n\n\nFAKE-SECRET:four\n");
    expect(record.args.slice(0, 5)).toEqual(["stdin", "--config", join(relayHome, "gitleaks.toml"), "--gitleaks-ignore-path", record.args[4]]);
    expect(record.args.at(-2)).toBe("--exit-code");
    expect(tmpFiles()).toEqual([]);
  });

  test("RELAY_HOME and RELAY_GITLEAKS come from the environment the caller passes", async () => {
    delete process.env.RELAY_GITLEAKS;
    const otherHome = join(root, "other-home");
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, RELAY_HOME: otherHome, RELAY_GITLEAKS: FAKE, FAKE_GITLEAKS_RECORD: join(root, "record.json") };
    expect(await scanTexts([{ label: "notes", text: "FAKE-SECRET\n" }], { env })).toEqual([{ label: "notes", line: 1, rule: "fake-rule" }]);
    const record = JSON.parse(readFileSync(join(root, "record.json"), "utf8"));
    expect(record.args[2]).toBe(join(otherHome, "gitleaks.toml"));
    expect(existsSync(join(relayHome, "tmp"))).toBe(false);
  });

  test("clean texts give no findings", async () => {
    expect(await scanTexts([{ label: "notes", text: "nothing here\n" }, { label: "empty", text: "" }])).toEqual([]);
    expect(tmpFiles()).toEqual([]);
  });

  test("a scan that cannot finish throws the checkpoint scan's error and removes its files", async () => {
    Object.assign(process.env, { FAKE_GITLEAKS_EXIT: "1", FAKE_GITLEAKS_STDERR: "failed to load config\n" });
    const error = await scanTexts([{ label: "notes", text: "x\n" }]).catch((caught) => caught);
    expect(error).toBeInstanceOf(CommandError);
    expect([error.code, error.lines]).toEqual([1, ["The secret scan did not finish: failed to load config. Nothing was saved."]]);
    expect(tmpFiles()).toEqual([]);
  });
});

describe("with the real gitleaks", () => {
  beforeEach(() => requireGitleaks());

  test("a GitHub token and an AWS key are found by label, line and rule, and never shown or kept", async () => {
    const token = fakeGithubToken();
    const awsKey = fakeAwsKey();
    const findings = await scanTexts([
      { label: "the prompt for Codex", text: "Continue the job described in .relay/task.md.\n" },
      { label: "Claude Code's handoff notes", text: `Done: the login form.\nNext: the callback.\nThe test account uses ${token}\n` },
      { label: "the instructions", text: `Deploy with aws_access_key_id = ${awsKey}\n` },
    ]);
    expect(findings).toEqual([
      { label: "Claude Code's handoff notes", line: 3, rule: "github-pat" },
      { label: "the instructions", line: 1, rule: "aws-access-token" },
    ]);
    for (const secret of [token, awsKey]) {
      expect(JSON.stringify(findings)).not.toContain(secret);
      expect(filesContaining(relayHome, secret)).toEqual([]);
    }
    expect(tmpFiles()).toEqual([]);
  });
});
