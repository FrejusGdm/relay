import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createClaudeAdapter } from "../../../../src/adapters/claude/adapter";
import type { StartRequest } from "../../../../src/adapters/types";
import type { Account } from "../../../../src/core/config/types";

const file = process.argv[2];
if (file === undefined) throw new Error("The interactive driver needs its request file.");
const input = JSON.parse(readFileSync(file, "utf8")) as {
  account: Account; request: StartRequest; eventsPath: string; infoPath: string; controlPath: string; resultPath: string;
};
const worker = await createClaudeAdapter(input.request.env).start(input.account, input.request);
let sendError = "";
try { await worker.send("Another message."); } catch (error) { sendError = (error as Error).message; }
writeFileSync(input.eventsPath, "");
writeFileSync(input.infoPath, JSON.stringify({ presetSessionId: worker.presetSessionId, sendError }));
let controlled = false;
let action: Promise<void> = Promise.resolve();
const timer = setInterval(() => {
  if (controlled || !existsSync(input.controlPath)) return;
  const control = JSON.parse(readFileSync(input.controlPath, "utf8")) as { operation: "stop" | "interrupt"; timeoutMs?: number };
  controlled = true;
  action = (async () => {
    if (control.operation === "interrupt") await worker.interrupt();
    else writeFileSync(input.resultPath, JSON.stringify(await worker.stop({ timeoutMs: control.timeoutMs })));
  })();
}, 10);
try {
  for await (const event of worker.events()) appendFileSync(input.eventsPath, `${JSON.stringify(event)}\n`);
  await action;
} finally {
  clearInterval(timer);
  await worker.stop({ timeoutMs: 100 });
}
