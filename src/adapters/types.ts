import type { Provider } from "./providers";             // add-cli-scaffold: "claude" | "codex"
import type { Account } from "../core/config/types";     // add-cli-scaffold: id ("claude:work"), provider, name,
                                                         // profileDir, profileDirIsDefault, credentialEnv, kind
export type ProviderId = Provider;
export type Mode = "interactive" | "headless";
export type Transport = "claude-print" | "claude-interactive" | "codex-app-server" | "codex-exec" | "codex-interactive";
export type PermissionLevel = "read-only" | "edit-in-workspace";   // "full-access" is refused before an adapter is called

// usesProviderDefaultFolder(account) in src/accounts/profile.ts is true when the profile folder is
// ~/.claude or ~/.codex; the profile variable is then left unset (decision 6).

export interface Capabilities {
  streamingInput: boolean;
  cleanInterrupt: boolean;
  nativeResume: boolean;
  limitPercentBeforeHit: boolean;
  limitSignalOnHit: "structured" | "text" | "none";
  observesExternalSessions: "hooks" | "poll" | "none";
}

export interface Detection { installed: boolean; path?: string; version?: string; tooOld?: { oldest: string } }

export interface StartRequest {
  jobId: string;
  workerId: string;
  cwd: string;                        // verified job worktree root, absolute
  mode: Mode;
  instructions: string;               // relay-written only; goes to the system channel
  prompt?: string;                    // first user message; required when headless
  resumeSessionId?: string;
  permission: PermissionLevel;        // ignored for interactive workers
  model?: string;
  env: Record<string, string>;        // built by src/accounts/environment.ts
  logPath: string;
}

export interface WorkerHandle {
  readonly workerId: string;
  readonly transport: Transport;
  readonly pid: number | null;
  readonly presetSessionId?: string;  // Claude: chosen before start
  readonly argv: string[];            // the program's arguments, with the instructions and the prompt
                                      // replaced by <instructions> and <prompt> (decision 16)
  events(): AsyncIterable<WorkerEvent>;
  send(text: string): Promise<void>;  // throws UnsupportedOperation when !streamingInput
  interrupt(): Promise<void>;
  stop(options?: { timeoutMs?: number }): Promise<StopResult>;   // end the worker cleanly (decision 5)
  wait(): Promise<{ code: number | null; signal: string | null }>;
}

export interface StopResult {
  how: "clean" | "terminated" | "killed" | "already_exited";
  exitCode: number | null; signal: string | null; turnEnded: boolean;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly displayName: string;       // "Claude Code", "Codex"
  readonly policy: ProviderPolicy;    // decision 12
  capabilities(transport: Transport): Capabilities;
  detect(): Promise<Detection>;
  authStatus(account: Account, env: Record<string, string>): Promise<{ signedIn: boolean; method?: string }>;
  loginCommand(account: Account): string[];        // ["claude","auth","login"] / ["codex","login"]
  start(account: Account, req: StartRequest): Promise<WorkerHandle>;
  availability(account: Account, env: Record<string, string>): Promise<Availability>;
  hookSpec(): HookSpec;                            // decision 13
}

// Decision 1 names ProviderPolicy and HookSpec without defining them. These shapes follow the
// policy file fields of decision 12 and the hook table of decision 13; tasks 4.1 and 6.2 own them.
export interface ProviderPolicy {
  provider: ProviderId;
  displayName: string;
  company: string;                    // the company that receives the code: "Anthropic", "OpenAI"
  checkedOn: string;
  maxAgeDays: number;
  signInMethods: string[];
  unattendedSubscriptionUse: string;
  sameProviderAutomaticSwitching: string;
  ownAccountsNote: string;            // shown before the first handoff to another account of the provider
  usageSignals: string[];
  summary: string;
  unclear: string;
  terms: { title: string; url: string }[];
}

export interface HookSpec { file: string; events: string[] }

export type FailureReason = "usage_limit" | "rate_limit" | "overloaded" | "auth" | "billing"
  | "context_full" | "interrupted" | "crashed" | "other";
export type ReadingSource = "provider_api" | "stream_event" | "hook" | "status_line" | "message_text" | "user" | "none";

export interface LimitWindow { name: string; windowMinutes?: number; usedPercent?: number; resetsAt?: Date; source: ReadingSource }
// name: "five_hour" (300 minutes), "seven_day" (10080 minutes), otherwise "<n>_minutes".
export interface TokenUsage { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number }

export type WorkerEvent =
  | { kind: "session_started"; providerSessionId: string; model?: string; providerVersion?: string; source: "preset" | "stream" | "hook" }
  | { kind: "message"; text: string; partial: boolean }
  | { kind: "tool"; toolId: string; name: string; status: "started" | "completed" | "failed" | "declined";
      command?: string; exitCode?: number; paths?: string[] }
  | { kind: "turn_completed"; usage?: TokenUsage; costUsdEstimate?: number; durationMs?: number }
  | { kind: "turn_failed"; reason: FailureReason; retryAt?: Date; message: string; source: ReadingSource }
  | { kind: "limit_update"; windows: LimitWindow[]; state?: AvailabilityState; retryAt?: Date; source: ReadingSource }
  | { kind: "approval_needed"; requestId: string; summary: string }
  | { kind: "permission_denied"; tool: string }
  | { kind: "exited"; code: number | null; signal: string | null };

export type AvailabilityState = "available" | "rate_limited" | "quota_exhausted" | "unavailable" | "unknown";
export interface Availability {
  account: string; state: AvailabilityState; retryAt?: Date; windows: LimitWindow[];
  observedAt: Date; source: ReadingSource; detail?: string;
}

export class UnsupportedOperation extends Error {}   // message: "<Display name> in <transport> mode cannot <operation>."
