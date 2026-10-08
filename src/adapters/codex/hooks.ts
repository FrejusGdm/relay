// Codex hook events for interactive workers, and the trust state of relay's hooks as the app
// server reports it with hooks/list.
import type { Account } from "../../core/config/types";
import type { SpoolLine } from "../../hooks/fields";
import { isRelayHook, relayProgram } from "../../hooks/install";
import { object } from "../mapper";
import type { WorkerEvent } from "../types";
import { isSessionId } from "../worker";
import { readCodexSession } from "./session";

export function codexHookEvents(line: SpoolLine): WorkerEvent[] {
  if (line.provider !== "codex") return [];
  // Any program can append to the spool, so a session ID that is not a UUID is ignored.
  if (line.event === "SessionStart" && isSessionId(line.fields.session_id)) {
    return [{ kind: "session_started", providerSessionId: line.fields.session_id, source: "hook" }];
  }
  return line.event === "Stop" ? [{ kind: "turn_completed" }] : [];
}

export function noSessionMessage(name: string): string {
  return `relay could not learn the Codex session ID because its hooks are not active. Run relay hooks status codex:${name}.`;
}

export async function readCodexHookTrust(
  account: Account, env: Record<string, string>, cwd: string,
): Promise<"trusted" | "untrusted" | "modified" | "unknown"> {
  const response = await readCodexSession(account, env, cwd, "hooks/list", { cwds: [cwd] });
  if (response.status !== "answer" || !object(response.result) || !Array.isArray(response.result.data)) return "unknown";
  const program = relayProgram(env);
  const states: unknown[] = [];
  for (const entry of response.result.data as unknown[]) {
    if (!object(entry) || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks as unknown[]) {
      if (object(hook) && typeof hook.command === "string" && isRelayHook(hook.command, "codex", program)) states.push(hook.trustStatus);
    }
  }
  if (states.includes("modified")) return "modified";
  if (states.includes("untrusted")) return "untrusted";
  return states.length > 0 && states.every((state) => state === "trusted") ? "trusted" : "unknown";
}
