// Turns Claude Code's stream-JSON output into worker events (add-provider-adapters, design
// decision 8; the claude-code-adapter spec). The fixtures in test/fixtures/providers/claude/print/
// hold the expected events.
import type { FailureReason, LimitWindow, WorkerEvent } from "../types";
import { number, object, stopped, tokenUsage } from "../mapper";
import type { MapperContext, StreamMapper } from "../mapper";
import { resetTimeFromText, resetTimeFromValue } from "../reset-time";

type Tool = Extract<WorkerEvent, { kind: "tool" }>;
const USAGE_FIELDS = [
  ["input_tokens", "inputTokens"], ["cache_read_input_tokens", "cachedInputTokens"], ["output_tokens", "outputTokens"],
] as const;
const LIMIT_TEXT = /You[’']ve hit your (session|weekly|Opus|Sonnet) limit · resets (.+)$/m;

export function createClaudeStreamMapper(context: MapperContext): StreamMapper {
  let unknown = 0;
  let open = false;
  let assistantError: string | undefined;
  let assistantText = "";
  let rejected = false;
  let retryAt: Date | undefined;
  const tools = new Map<string, Tool>();
  function begin() {
    if (open) return;
    open = true;
    assistantError = undefined;
    assistantText = "";
    rejected = false;
    retryAt = undefined;
    tools.clear();
  }
  return {
    get unknown() { return unknown; },
    push(message) {
      if (!object(message) || typeof message.type !== "string") return [];
      if (message.type === "system") {
        if (message.subtype === "api_retry") return [];
        if (message.subtype !== "init") { if (typeof message.subtype === "string") unknown++; return []; }
        if (typeof message.session_id !== "string") return [];
        begin();
        return [{ kind: "session_started", providerSessionId: message.session_id, source: "stream",
          ...(typeof message.model === "string" ? { model: message.model } : {}),
          ...(typeof message.claude_code_version === "string" ? { providerVersion: message.claude_code_version } : {}),
        }];
      }
      if (message.type === "assistant" || message.type === "user") {
        if (!object(message.message) || !Array.isArray(message.message.content)) return [];
        const events: WorkerEvent[] = [];
        for (const block of message.message.content as unknown[]) {
          if (!object(block)) continue;
          if (message.type === "assistant" && block.type === "text" && typeof block.text === "string") {
            begin();
            if (typeof message.error === "string") assistantError = message.error;
            assistantText = block.text;
            events.push({ kind: "message", text: block.text, partial: false });
          } else if (message.type === "assistant" && block.type === "tool_use") {
            if (typeof block.id !== "string" || typeof block.name !== "string" || !object(block.input)) continue;
            begin();
            if (typeof message.error === "string") assistantError = message.error;
            const tool: Tool = { kind: "tool", toolId: block.id, name: block.name, status: "started" };
            if (block.name === "Bash" && typeof block.input.command === "string") tool.command = block.input.command;
            if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(block.name) && typeof block.input.file_path === "string") tool.paths = [block.input.file_path];
            tools.set(block.id, tool);
            events.push(tool);
          } else if (message.type === "user" && block.type === "tool_result") {
            if (typeof block.tool_use_id !== "string" || (block.is_error !== undefined && typeof block.is_error !== "boolean")) continue;
            const tool = tools.get(block.tool_use_id);
            if (tool === undefined) continue;
            const result: Tool = { ...tool, status: block.is_error === true ? "failed" : "completed" };
            if (tool.name === "Bash") {
              if (block.is_error !== true) result.exitCode = 0;
              else {
                const text = typeof block.content === "string" ? block.content : Array.isArray(block.content)
                  ? block.content.flatMap((part: unknown) => object(part) && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
                const code = text.match(/Exit code (-?\d+)/)?.[1];
                if (code !== undefined && number(Number(code))) result.exitCode = Number(code);
              }
            }
            events.push(result);
          }
        }
        return events;
      }
      if (message.type === "rate_limit_event") {
        if (!object(message.rate_limit_info)) return [];
        const info = message.rate_limit_info;
        if (typeof info.rate_limit_type !== "string") return [];
        begin();
        const resetsAt = resetTimeFromValue(info.resetsAt);
        const window: LimitWindow = { name: info.rate_limit_type, source: "stream_event" };
        if (info.rate_limit_type === "five_hour") window.windowMinutes = 300;
        if (info.rate_limit_type === "seven_day") window.windowMinutes = 10080;
        if (number(info.utilization)) window.usedPercent = info.utilization * 100;
        if (resetsAt !== undefined) window.resetsAt = resetsAt;
        if (info.status === "rejected") { rejected = true; retryAt = resetsAt; }
        return [{ kind: "limit_update", windows: [window], source: "stream_event",
          ...(info.status === "rejected" ? { state: "quota_exhausted" as const, ...(resetsAt !== undefined ? { retryAt: resetsAt } : {}) } : {}),
        }];
      }
      if (message.type === "result") {
        if (typeof message.is_error !== "boolean") return [];
        open = false;
        if (message.is_error) {
          if (context.interruptSent) return [{ kind: "turn_failed", reason: "interrupted", message: "Interrupted.", source: "stream_event" }];
          const text = typeof message.result === "string" ? message.result : assistantText;
          let reason: FailureReason = assistantError === "overloaded" ? "overloaded" : assistantError === "authentication_failed" ? "auth" : assistantError === "billing_error" ? "billing" : "other";
          if (assistantError === "rate_limit") {
            if (rejected) return [{ kind: "turn_failed", reason: "usage_limit", message: text.slice(0, 300), source: "stream_event", ...(retryAt !== undefined ? { retryAt } : {}) }];
            const reset = resetTimeFromText(text.match(LIMIT_TEXT)?.[2] ?? "")
              ?? resetTimeFromText(assistantText.match(LIMIT_TEXT)?.[2] ?? "");
            if (reset !== undefined) return [{ kind: "turn_failed", reason: "usage_limit", message: text.slice(0, 300), retryAt: reset, source: "message_text" }];
            reason = "rate_limit";
          }
          return [{ kind: "turn_failed", reason, message: text.slice(0, 300), source: "stream_event" }];
        }
        const events: WorkerEvent[] = [];
        if (Array.isArray(message.permission_denials)) for (const denial of message.permission_denials as unknown[]) {
          if (object(denial) && typeof denial.tool_name === "string") events.push({ kind: "permission_denied", tool: denial.tool_name });
        }
        const usage = tokenUsage(message.usage, USAGE_FIELDS);
        events.push({ kind: "turn_completed", ...(usage !== undefined ? { usage } : {}),
          ...(number(message.total_cost_usd) ? { costUsdEstimate: message.total_cost_usd } : {}),
          ...(number(message.duration_ms) ? { durationMs: message.duration_ms } : {}),
        });
        return events;
      }
      unknown++;
      return [];
    },
    end() {
      if (!open) return [];
      open = false;
      return [stopped(context)];
    },
  };
}
