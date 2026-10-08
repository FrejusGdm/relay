export const PROVIDERS = ["claude", "codex"] as const;

export type Provider = (typeof PROVIDERS)[number];
