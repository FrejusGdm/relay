import { expect, test } from "bun:test";
import { APPROVAL_METHODS } from "../../../src/adapters/codex/protocol";
import type { Step } from "../../fakes/scenario";
import { codexTest, until } from "./helpers/worker";

for (const method of APPROVAL_METHODS) {
  test(`${method} emits an approval event and never gets a response`, async () => {
    const step: Step = method === "item/commandExecution/requestApproval" ? { approval: { command: "rm -rf build" } }
      : method === "item/fileChange/requestApproval" ? { approval: { path: "src/a.ts" } }
        : { raw: JSON.stringify({ id: "server_request", method, params: {} }) };
    const fixture = codexTest([step, { hang: true }]);
    try {
      const worker = await fixture.start();
      await until(() => fixture.events.some((event) => event.kind === "approval_needed"));
      const approval = fixture.events.find((event) => event.kind === "approval_needed");
      expect(approval).toMatchObject({ kind: "approval_needed", summary: method === "item/commandExecution/requestApproval"
        ? "run rm -rf build" : method === "item/fileChange/requestApproval" ? "change src/a.ts" : method });
      await worker.stop({ timeoutMs: 1000 });
      await fixture.finished();
      expect(fixture.messages().some((message) => message.id === approval?.requestId && message.method === undefined)).toBe(false);
      expect(fixture.messages().filter((message) => message.method === undefined)).toEqual([]);
      expect(fixture.events.some((event) => event.kind === "turn_failed" && event.reason === "interrupted")).toBe(true);
    } finally { await fixture.cleanup(); }
  });
}
