import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCodexHookTrust } from "../../src/adapters/codex/hooks";
import { codexTest } from "../adapters/codex/helpers/worker";
import { scriptedAppServer } from "../adapters/codex/helpers/app-server";

for (const [trust, expected] of [[true, "trusted"], [false, "untrusted"], ["modified", "modified"]] as const) {
  test(`Codex reports relay's five hooks as ${expected}`, async () => {
    const fixture = codexTest([], { hooks_trusted: trust });
    try {
      const hooks = Object.fromEntries(["SessionStart", "Stop", "SessionEnd", "Interrupt", "PreCompact"].map((event) => [event,
        [{ hooks: [{ type: "command", command: `'/usr/local/bin/relay' hook codex ${event}`, timeout: ["SessionEnd", "Interrupt"].includes(event) ? 3 : 5 }] }],
      ]));
      writeFileSync(join(fixture.profile, "hooks.json"), JSON.stringify({ hooks }));
      expect(await readCodexHookTrust(fixture.account, fixture.env, fixture.root)).toBe(expected);
      expect(fixture.messages().map((message) => message.method)).toEqual(["initialize", "initialized", "hooks/list"]);
      expect(fixture.messages()[2]?.params).toEqual({ cwds: [fixture.root] });
    } finally { await fixture.cleanup(); }
  });
}

test("missing hooks and other programs' hooks leave relay's trust unknown", async () => {
  const fixture = codexTest([], { hooks_trusted: true });
  try {
    expect(await readCodexHookTrust(fixture.account, fixture.env, fixture.root)).toBe("unknown");
    writeFileSync(join(fixture.profile, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other-program", timeout: 5 }] }] } }));
    expect(await readCodexHookTrust(fixture.account, fixture.env, fixture.root)).toBe("unknown");
  } finally { await fixture.cleanup(); }
});

for (const [states, expected] of [
  [["trusted", "untrusted"], "untrusted"],
  [["trusted", "untrusted", "modified"], "modified"],
  [["trusted", "new_status"], "unknown"],
] as const) {
  test(`mixed relay hook states choose ${expected}`, async () => {
    const fixture = codexTest();
    try {
      const path = scriptedAppServer(fixture.root, { hooks: [
        { command: "other-program", trustStatus: "modified" },
        ...states.map((trustStatus) => ({ command: "'/usr/local/bin/relay' hook codex Stop", trustStatus })),
      ] });
      expect(await readCodexHookTrust(fixture.account, { ...fixture.env, RELAY_CODEX_BIN: path }, fixture.root)).toBe(expected);
    } finally { await fixture.cleanup(); }
  });
}

test("hook listing errors leave trust unknown", async () => {
  const fixture = codexTest();
  try {
    const path = scriptedAppServer(fixture.root, { errorMethod: "hooks/list" });
    expect(await readCodexHookTrust(fixture.account, { ...fixture.env, RELAY_CODEX_BIN: path }, fixture.root)).toBe("unknown");
  } finally { await fixture.cleanup(); }
});
