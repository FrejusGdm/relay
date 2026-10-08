import { expect, test } from "bun:test";
import { runRelayInProcess } from "../helpers/cli";
import { fakeEnv } from "../helpers/fake-programs";

test("both installed", async () => {
  const { code, stdout } = await runRelayInProcess(["providers"], { env: fakeEnv() });
  expect(code).toBe(0);
  expect(stdout).toBe(
    "claude   Claude Code 2.1.282   headless (claude -p), interactive\n" +
      "codex    Codex 0.160.0         headless (app server, codex exec fallback), interactive\n",
  );
});

test("Codex missing", async () => {
  const { code, stdout } = await runRelayInProcess(["providers"], { env: { ...fakeEnv(), RELAY_CODEX_BIN: "/nonexistent/codex" } });
  expect(code).toBe(0);
  expect(stdout).toBe("claude   Claude Code 2.1.282   headless (claude -p), interactive\ncodex    not installed\n");
});

test("an old Claude Code is named as too old", async () => {
  const { stdout } = await runRelayInProcess(["providers"], { env: fakeEnv({ tool_version: "2.1.100" }) });
  expect(stdout).toContain("claude   Claude Code 2.1.100 (relay needs 2.1.282 or newer)   headless (claude -p), interactive\n");
});

test("the JSON shape", async () => {
  const { code, stdout } = await runRelayInProcess(["providers", "--json"], { env: fakeEnv() });
  expect(code).toBe(0);
  const json = JSON.parse(stdout);
  expect(Object.keys(json)).toEqual(["providers"]);
  expect(json.providers.map((provider: { id: string; installed: boolean; version: string }) => [provider.id, provider.installed, provider.version]))
    .toEqual([["claude", true, "2.1.282"], ["codex", true, "0.160.0"]]);
  expect(json.providers[1].transports.map((transport: { id: string }) => transport.id)).toEqual(["codex-app-server", "codex-exec", "codex-interactive"]);
  for (const provider of json.providers) {
    for (const transport of provider.transports) {
      const capabilities = transport.capabilities;
      for (const field of ["streamingInput", "cleanInterrupt", "nativeResume", "limitPercentBeforeHit"]) expect(typeof capabilities[field]).toBe("boolean");
      expect(["structured", "text", "none"]).toContain(capabilities.limitSignalOnHit);
      expect(["hooks", "poll", "none"]).toContain(capabilities.observesExternalSessions);
    }
  }
  expect(json.providers[0].transports[0]).toEqual({
    id: "claude-print",
    capabilities: { streamingInput: true, cleanInterrupt: true, nativeResume: true, limitPercentBeforeHit: false, limitSignalOnHit: "structured", observesExternalSessions: "hooks" },
  });
});
