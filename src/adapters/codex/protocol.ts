// The part of the Codex app-server protocol relay uses, written by hand from the types that
// `codex app-server generate-ts` produces (design decision 4). scripts/check-codex-protocol.ts
// checks the names in src/adapters/codex/protocol-used.json against the installed Codex.
export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities?: { experimentalApi: boolean; requestAttestation: boolean } | null;
}
export interface ThreadStartParams {
  cwd?: string | null;
  sandbox?: "read-only" | "workspace-write" | null;
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never" | null;
  developerInstructions?: string | null;
  model?: string | null;
}
export interface ThreadResumeParams extends ThreadStartParams { threadId: string }
export interface TurnStartParams {
  threadId: string;
  input: { type: "text"; text: string; text_elements: unknown[] }[];
}
export interface TurnSteerParams extends TurnStartParams { expectedTurnId: string }
export interface TurnInterruptParams { threadId: string; turnId: string }

export interface Thread { id: string; cliVersion: string }
export interface Turn {
  id: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  error: TurnError | null;
}
export interface TurnError { message: string; codexErrorInfo: string | Record<string, unknown> | null }
export interface RateLimitWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  rateLimitReachedType: string | null;
}
export interface GetAccountRateLimitsResponse { rateLimits: RateLimitSnapshot; ordinaryUsageAllowed: boolean | null }
export interface HookMetadata { eventName: string; trustStatus: "trusted" | "untrusted" | "modified" }

export const APPROVAL_METHODS = [
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request",
] as const;
