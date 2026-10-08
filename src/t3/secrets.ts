import { T3Error } from "./client";

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export const SECRET_SERVICE = "relay-t3";

export function osSecretStore(): SecretStore {
  const unavailable = () => new T3Error("token_rejected", process.platform === "darwin"
    ? "there is no credential store to keep the T3 Code token in. Unlock your macOS Keychain, then run relay t3 connect again."
    : "there is no credential store to keep the T3 Code token in. Install and unlock a Secret Service provider (for example GNOME Keyring), then run relay t3 connect again.");
  // Never repeat a native error: it may include the credential or the supplied value.
  return {
    async get(name) {
      try { return await Bun.secrets.get({ service: SECRET_SERVICE, name }); }
      catch { throw unavailable(); }
    },
    async set(name, value) {
      try { await Bun.secrets.set({ service: SECRET_SERVICE, name, value }); }
      catch { throw unavailable(); }
    },
    async delete(name) {
      try { return await Bun.secrets.delete({ service: SECRET_SERVICE, name }); }
      catch { throw unavailable(); }
    },
  };
}

export function memorySecretStore(): SecretStore {
  const entries = new Map<string, string>();
  return {
    async get(name) { return entries.get(name) ?? null; },
    async set(name, value) { entries.set(name, value); },
    async delete(name) { return entries.delete(name); },
  };
}
