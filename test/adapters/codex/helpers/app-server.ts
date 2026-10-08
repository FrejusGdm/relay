import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The regular fake cannot return startup errors or ignore the end of input.
export function scriptedAppServer(root: string, options: {
  errorMethod?: string; code?: number; hang?: boolean; hooks?: { command: string; trustStatus: string }[];
}): string {
  const path = join(root, "scripted-codex.ts");
  const recorder = resolve(import.meta.dir, "../../../fakes/record.ts");
  writeFileSync(path, `#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { startRecord } from ${JSON.stringify(recorder)};
const options = ${JSON.stringify(options)};
const record = startRecord(process.argv.slice(2));
const output = (value) => writeSync(1, JSON.stringify(value) + "\\n");
if (options.hang) setInterval(() => {}, 1000);
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let pending = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  pending += decoder.decode(value, { stream: true });
  let end;
  while ((end = pending.indexOf("\\n")) !== -1) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    record?.input(line);
    const message = JSON.parse(line);
    if (message.method === "initialized") continue;
    if (message.method === options.errorMethod) {
      output({ id: message.id, error: { code: options.code ?? -32602, message: "The requested operation failed." } });
    } else if (message.method === "initialize") output({ id: message.id, result: {} });
    else if (message.method === "hooks/list") output({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], hooks: options.hooks ?? [] }] } });
    else if (message.method.startsWith("thread/")) output({ id: message.id, result: { thread: { id: "scripted_thread" } } });
    else if (message.method === "turn/start") {
      output({ id: message.id, result: { turn: { id: "scripted_turn", status: "inProgress" } } });
      output({ method: "item/agentMessage/delta", params: { delta: "Ready." } });
    }
  }
}
`, { mode: 0o755 });
  return path;
}

export function unresponsiveExec(root: string, ignoreTerm: boolean): string {
  const path = join(root, "unresponsive-codex.ts");
  writeFileSync(path, `#!/usr/bin/env bun
process.on("SIGINT", () => {});
process.on("SIGTERM", () => { ${ignoreTerm ? "" : "process.exit(143);"} });
console.log(JSON.stringify({ type: "thread.started", thread_id: "unresponsive_thread" }));
console.log(JSON.stringify({ type: "turn.started" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Ready." } }));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return path;
}
