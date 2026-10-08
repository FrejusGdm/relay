import { expect, test } from "bun:test";
import { mayAutoSwitch } from "../../src/policies/switching";

test("two Claude accounts: refused with the reason", () => {
  expect(mayAutoSwitch({ provider: "claude" }, { provider: "claude" })).toEqual({
    allowed: false,
    reason: "Automatic switching between two Claude accounts is off. Anthropic's terms say plan limits assume ordinary, individual use.",
  });
});

test("two Codex accounts: refused", () => {
  const answer = mayAutoSwitch({ provider: "codex" }, { provider: "codex" });
  expect(answer.allowed).toBe(false);
  expect(answer.reason).toStartWith("Automatic switching between two Codex accounts is off.");
});

test("Claude to Codex is not refused by this rule", () => {
  expect(mayAutoSwitch({ provider: "claude" }, { provider: "codex" })).toEqual({ allowed: true });
});
