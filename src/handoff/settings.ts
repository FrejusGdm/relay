// RELAY_HOME/jobs/<job>/handoff-settings.json (add-relay-switch, design decisions 9, 18 and 21):
// the job's mode, its permission ceiling and its check commands. The file lives outside the project,
// so an agent cannot raise the ceiling or add a check by editing a file in the repository.
import { join } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { printable } from "../core/quote";
import { readPrivateFile } from "../core/relay-home";
import { isJobId } from "../job/id";
import type { Mode, PermissionLevel } from "../adapters/types";
import { jobFolder, writePrivateFile } from "./files";

export interface CheckSetting {
  command: string;
  timeout_seconds: number;
  added_at: string;
}

export interface HandoffSettings {
  schema_version: 1;
  job_id: string;
  mode: Mode;
  // The ceiling of a headless job; null for an interactive job.
  permission: PermissionLevel | null;
  checks: CheckSetting[];
  next_handoff: number;
}

const MAX_BYTES = 1024 * 1024;
const LEVELS: (PermissionLevel | null)[] = ["read-only", "edit-in-workspace", null];

export function handoffSettingsPath(relayHome: string, jobId: string): string {
  return join(jobFolder(relayHome, jobId), "handoff-settings.json");
}

// The job's settings, or null before the first relay run of the job wrote them. A damaged file stops
// the command, because guessing its mode or ceiling could raise the permission of the next agent.
export function readHandoffSettings(relayHome: string, jobId: string, uid = process.getuid!()): HandoffSettings | null {
  const path = handoffSettingsPath(relayHome, jobId);
  let text: string | null;
  try {
    text = readPrivateFile(path, uid, MAX_BYTES);
  } catch {
    throw damaged(path, "relay cannot read it safely");
  }
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw damaged(path, "it is not valid JSON");
  }
  if (!isSettings(value, jobId)) throw damaged(path, "a field is missing or has the wrong type");
  return value;
}

export function writeHandoffSettings(relayHome: string, settings: HandoffSettings, afterWrite?: () => void): void {
  writePrivateFile(handoffSettingsPath(relayHome, settings.job_id), `${JSON.stringify(settings, null, 2)}\n`, afterWrite);
}

function damaged(path: string, problem: string): CommandError {
  return new CommandError(ExitCode.NotPossibleHere, [`The job file ${printable(path)} is damaged: ${problem}.`]);
}

function isSettings(value: unknown, jobId: string): value is HandoffSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return settings.schema_version === 1
    && isJobId(settings.job_id) && settings.job_id === jobId
    && (settings.mode === "interactive" || settings.mode === "headless")
    && LEVELS.includes(settings.permission as PermissionLevel | null)
    && (settings.mode === "headless") === (settings.permission !== null)
    && Array.isArray(settings.checks) && settings.checks.every(isCheck)
    && Number.isSafeInteger(settings.next_handoff) && (settings.next_handoff as number) >= 1;
}

function isCheck(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const check = value as Record<string, unknown>;
  return typeof check.command === "string" && check.command !== "" && !check.command.includes("\n") && check.command.length <= 500
    && Number.isSafeInteger(check.timeout_seconds) && (check.timeout_seconds as number) >= 1
    && typeof check.added_at === "string" && !Number.isNaN(Date.parse(check.added_at));
}
