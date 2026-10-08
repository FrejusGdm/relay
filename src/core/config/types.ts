import type { Provider } from "../../adapters/providers";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type AccountId = `${Provider}:${string}`;

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

export interface RelayConfig {
  file: string;                // <relay folder>/config.toml
  exists: boolean;
  version: 1;
  defaults: { account: AccountId | null };
  log: { level: LogLevel | null };
  checkpoint: { maxFileSizeMb: number };
  accounts: Account[];         // in file order
  projects: Project[];         // in file order
}

export interface ConfigProblem { key: string; message: string }   // printed as "  <key>: <message>"
