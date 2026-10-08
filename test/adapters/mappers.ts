import { createClaudeStreamMapper } from "../../src/adapters/claude/stream";
import { createAppServerMapper } from "../../src/adapters/codex/app-server";
import { createExecMapper } from "../../src/adapters/codex/exec-stream";
import type { MapperFactory } from "./fixtures";

export const MAPPERS: Record<"claude-print" | "codex-app-server" | "codex-exec", MapperFactory> = {
  "claude-print": createClaudeStreamMapper,
  "codex-app-server": createAppServerMapper,
  "codex-exec": createExecMapper,
};
