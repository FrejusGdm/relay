import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The preload (test/setup.ts) sets RELAY_HOME to <root>/relay-home before any test file loads.
const root = dirname(process.env.RELAY_HOME!);

// Returns a new relay folder for one test. Tests use it instead of the preload's RELAY_HOME.
export function makeRelayHome(configText?: string, mode = 0o600): string {
  const relayHome = mkdtempSync(join(root, "relay-home-"));
  if (configText !== undefined) {
    const file = join(relayHome, "config.toml");
    writeFileSync(file, configText);
    chmodSync(file, mode);
  }
  return relayHome;
}
