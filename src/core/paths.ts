import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SettingsError } from "../cli/errors";
import { quote } from "./quote";

type Env = Record<string, string | undefined>;

// Bun's os.homedir() ignores a HOME that the process changed, so HOME comes first (design
// decision 4). Without this, a test that sets HOME could reach the person's real ~/.relay.
// A relative HOME would put the relay folder inside the current folder, so it is not used.
export function resolveHomedir(env: Env): string {
  const home = env.HOME;
  return home && isAbsolute(home) ? home : homedir();
}

// RELAY_HOME when it is set and not empty, otherwise <home>/.relay.
export function resolveRelayHome(env: Env, home: string): string {
  const value = env.RELAY_HOME;
  if (!value) return join(home, ".relay");
  const path = expandPath(value, home);
  if (path === null) throw new SettingsError([`relay: RELAY_HOME must be an absolute path, not ${quote(value)}.`]);
  if (path === resolve(home)) {
    throw new SettingsError([
      `relay: RELAY_HOME cannot be your home folder itself (${quote(value)}). Use a folder of its own, such as ~/.relay.`,
    ]);
  }
  return path;
}

// Expands "~" and a leading "~/", removes a trailing slash and resolves "." and "..".
// Returns null for a relative path.
export function expandPath(value: string, home: string): string | null {
  if (value === "~") return resolve(home);
  // Drop every slash after "~" so "~//x" stays under the home folder instead of becoming "/x".
  if (value.startsWith("~/")) return resolve(home, value.slice(1).replace(/^\/+/, ""));
  if (isAbsolute(value)) return resolve(value);
  return null;
}
