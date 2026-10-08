// The daemon's log, logs/daemon.log (design.md decision 8): the phase 1 JSON-lines logger with its
// rotation at 10 MB and five older files, plus a filter. The filter drops fields that could carry
// secrets or a person's work even if a caller passes them by mistake: the environment, hook
// payload fields outside the allow list, request bodies and headers, and any value that is not a
// plain string, number, boolean, null or list of strings.
import type { LogLevel } from "../core/config/types";
import { openLog, type LogFields, type Logger } from "../core/log";
import { VERSION } from "../core/version";

const DROPPED = new Set([
  "env",
  "environment",
  "tool_input",
  "tool_response",
  "transcript_path",
  "error_details",
  "body",
  "headers",
]);

interface DaemonLogOptions {
  relayHome: string;
  level: LogLevel;
  maxBytes?: number;   // tests lower the 10 MB limit
  onFailure: (file: string, reason: string) => void;
}

export function openDaemonLog(opts: DaemonLogOptions): Logger {
  const log = openLog({
    relayHome: opts.relayHome,
    file: "daemon.log",
    level: opts.level,
    version: VERSION,
    invocation: Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    maxBytes: opts.maxBytes,
    onFailure: opts.onFailure,
  });
  const write = (method: "debug" | "info" | "warn" | "error") => (msg: string, fields?: LogFields) =>
    log[method](msg, fields === undefined ? undefined : allowed(fields));
  return {
    get file() {
      return log.file;
    },
    get writing() {
      return log.writing;
    },
    setLevel: (level) => log.setLevel(level),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

function allowed(fields: LogFields): LogFields {
  const kept: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (DROPPED.has(key.toLowerCase()) || !isLogValue(value)) continue;
    kept[key] = value;
  }
  return kept;
}

function isLogValue(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.every((item) => typeof item === "string");
  return ["string", "number", "boolean"].includes(typeof value);
}
