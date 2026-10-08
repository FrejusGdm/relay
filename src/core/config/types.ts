import type { Provider } from "../../adapters/providers";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type AccountId = `${Provider}:${string}`;

export const LIMIT_WINDOWS = ["five_hour", "seven_day"] as const;
export type LimitWindow = (typeof LIMIT_WINDOWS)[number];
export const LIMIT_ACTIONS = ["wait", "switch", "notify"] as const;
export type LimitAction = (typeof LIMIT_ACTIONS)[number];

export interface T3Instance { id: string; account: AccountId; model: string | null }
export interface T3Settings { url: string; projects: string[]; instances: T3Instance[] }
export interface LimitSetting {
  account: AccountId;
  window: LimitWindow;
  threshold: number | null;
  action: LimitAction | null;
  switchTo: AccountId | null;
}

export interface Account {
  id: AccountId;               // "claude:personal"
  provider: Provider;          // "claude"
  name: string;                // "personal"
  profileDir: string;          // absolute, normalized
  profileDirIsDefault: boolean;
  credentialEnv: string[];     // names only, for example ["ANTHROPIC_API_KEY"]
  kind: "personal" | "work" | null;
}

export interface Project {
  path: string;                // absolute, normalized
  allow: AccountId[];          // in file order
}

// The [handoff] table (add-relay-switch, design decision 22).
export interface HandoffConfig {
  askForSummary: boolean;
  summaryTimeoutSeconds: number;
  stopTimeoutSeconds: number;
  checkTimeoutSeconds: number;
  startCheckSeconds: number;
}

export interface RelayConfig {
  file: string;                // <relay folder>/config.toml
  exists: boolean;
  version: 1;
  defaults: { account: AccountId | null };
  log: { level: LogLevel | null };
  checkpoint: { maxFileSizeMb: number };
  accounts: Account[];         // in file order
  projects: Project[];         // in file order
  t3: T3Settings;
  limits: LimitSetting[];      // in file order
  handoff: HandoffConfig;
}

export interface ConfigProblem { key: string; message: string }   // printed as "  <key>: <message>"
