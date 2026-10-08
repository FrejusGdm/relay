// Turns the JSON lines of Codex's exec mode into worker events (the codex-adapter spec, "codex exec
// fallback"). A usage limit is read from the message text, the only signal this mode gives.
import { changedPaths, completedToolStatus, object, number, stopped, tokenUsage } from "../mapper";
import type { MapperContext, StreamMapper } from "../mapper";
import { resetTimeFromText } from "../reset-time";

const USAGE_FIELDS = [
  ["input_tokens", "inputTokens"], ["cached_input_tokens", "cachedInputTokens"],
  ["output_tokens", "outputTokens"], ["reasoning_output_tokens", "reasoningOutputTokens"],
] as const;

export function createExecMapper(context: MapperContext): StreamMapper {
  let unknown = 0;
  let open = false;
  return {
    get unknown() { return unknown; },
    push(message) {
      if (!object(message) || typeof message.type !== "string") return [];
      switch (message.type) {
        case "thread.started":
          if (typeof message.thread_id !== "string") return [];
          return [{ kind: "session_started", providerSessionId: message.thread_id, source: "stream" }];
        case "turn.started": open = true; return [];
        case "item.started": case "item.updated": case "error": return [];
        case "item.completed": {
          const item = message.item;
          if (!object(item) || typeof item.type !== "string") return [];
          if (item.type === "agent_message") {
            if (typeof item.text !== "string") return [];
            open = true;
            return [{ kind: "message", text: item.text, partial: false }];
          }
          if (typeof item.id !== "string") return [];
          const status = completedToolStatus(item.status);
          if (status === undefined) return [];
          if (item.type === "command_execution") {
            if (typeof item.command !== "string") return [];
            open = true;
            return [{ kind: "tool", toolId: item.id, name: "command_execution", status, command: item.command,
              ...(number(item.exit_code) ? { exitCode: item.exit_code } : {}),
            }];
          }
          if (item.type === "file_change") {
            const paths = changedPaths(item.changes);
            if (paths === undefined) return [];
            open = true;
            return [{ kind: "tool", toolId: item.id, name: "file_change", status, paths }];
          }
          return [];
        }
        case "turn.completed": {
          open = false;
          const usage = tokenUsage(message.usage, USAGE_FIELDS);
          return [{ kind: "turn_completed", ...(usage !== undefined ? { usage } : {}) }];
        }
        case "turn.failed": {
          if (!object(message.error) || typeof message.error.message !== "string") return [];
          open = false;
          const text = message.error.message;
          const limited = /hit your usage limit/i.test(text);
          const retryAt = limited ? resetTimeFromText(text.match(/try again at (.+)$/im)?.[1] ?? "") : undefined;
          return [{ kind: "turn_failed", reason: limited ? "usage_limit" : "other", message: text.slice(0, 300), source: "message_text",
            ...(retryAt !== undefined ? { retryAt } : {}),
          }];
        }
        default: unknown++; return [];
      }
    },
    end() {
      if (!open) return [];
      open = false;
      return [stopped(context)];
    },
  };
}
