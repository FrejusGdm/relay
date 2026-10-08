import { afterEach, expect, test } from "bun:test";
import { setClock } from "../../src/platform/clock";
import { runRelayInProcess } from "../helpers/cli";

afterEach(() => setClock(null));
const at = (time: string) => setClock(() => new Date(time));

test("relay policy show claude prints the whole policy", async () => {
  at("2026-10-08T12:00:00");
  const { code, stdout, stderr } = await runRelayInProcess(["policy", "show", "claude"]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  for (const text of [
    "Claude Code policy notes",
    "relay starts the Claude Code program you installed",
    "Claude Code's own login (claude auth login) in the unmodified claude program",
    "rate_limit_event in claude -p stream JSON",
    "Unattended use on a subscription: unclear.",
    "Automatic switching between two Claude accounts: off.",
    "No Anthropic page says whether long unattended runs",
    "  Anthropic Usage Policy  https://www.anthropic.com/legal/aup",
  ]) expect(stdout).toContain(text);
  expect(stdout.endsWith("Last checked 2026-10-07.\n")).toBe(true);
  expect(stdout).not.toContain("out of date");
});

test("an old policy is flagged", async () => {
  at("2027-01-10T12:00:00");
  const { code, stdout } = await runRelayInProcess(["policy", "show", "claude"]);
  expect(code).toBe(0);
  expect(stdout).toContain("Last checked 2026-10-07 (95 days ago). This may be out of date.");
});

test("relay policy show codex names the Codex rule", async () => {
  at("2026-10-08T12:00:00");
  const { stdout } = await runRelayInProcess(["policy", "show", "codex"]);
  expect(stdout).toContain("Automatic switching between two Codex accounts: off.");
  expect(stdout).toContain("  OpenAI Terms of Use  https://openai.com/policies/terms-of-use/");
});

test("an unknown provider exits 2", async () => {
  const { code, stdout, stderr } = await runRelayInProcess(["policy", "show", "cursor"]);
  expect({ code, stdout }).toEqual({ code: 2, stdout: "" });
  expect(stderr).toBe("relay has no adapter for cursor yet. Supported providers: claude, codex.\n");
});

test("an action other than show exits 2", async () => {
  const { code, stderr } = await runRelayInProcess(["policy", "list", "claude"]);
  expect(code).toBe(2);
  expect(stderr).toContain('"list" is not a policy action.');
});
