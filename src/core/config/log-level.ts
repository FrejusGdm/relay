import { SettingsError } from "../../cli/errors";
import { quote } from "../quote";
import { LOG_LEVELS, type LogLevel, type RelayConfig } from "./types";

// The --log-level flag wins, then RELAY_LOG_LEVEL, then log.level in the settings, then info.
// An invalid RELAY_LOG_LEVEL is a settings error even when the flag is given.
// config is null before the settings are loaded.
export function resolveLogLevel(
  flag: LogLevel | undefined,
  env: Record<string, string | undefined>,
  config: RelayConfig | null,
): LogLevel {
  const value = env.RELAY_LOG_LEVEL;
  if (value && !(LOG_LEVELS as readonly string[]).includes(value)) {
    throw new SettingsError([`relay: RELAY_LOG_LEVEL must be debug, info, warn or error, not ${quote(value)}.`]);
  }
  if (flag !== undefined) return flag;
  if (value) return value as LogLevel;
  return config?.log.level ?? "info";
}
