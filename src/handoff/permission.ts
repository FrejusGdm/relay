// Mode and permission never go up at a handoff (add-relay-switch, design decision 18;
// docs/research/security.md section 5). The job's mode and the ceiling of a headless job come from
// handoff-settings.json under RELAY_HOME, never from a file in the project.
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import type { Mode, PermissionLevel } from "../adapters/types";
import type { HandoffSettings } from "./settings";

const RANK: Record<PermissionLevel, number> = { "read-only": 0, "edit-in-workspace": 1 };

interface NextStart {
  mode: Mode | "none";
  // The level of a headless start; null for an interactive start or none.
  permission: PermissionLevel | null;
}

// The mode and level the next agent starts with. The next agent keeps the job's mode: a headless
// start of an interactive job is refused, and a headless job starts headless. A headless job starts
// at the requested level, else at the outgoing worker's level, and never above the ceiling.
export function nextStart(
  settings: Pick<HandoffSettings, "mode" | "permission">,
  request: { startMode: Mode | "none"; permission?: PermissionLevel; outgoingLevel: PermissionLevel | null },
): NextStart {
  if (settings.mode === "interactive") {
    if (request.startMode === "headless") {
      throw new CommandError(ExitCode.WouldRaisePermission, [
        "This job runs agents in your terminal. relay switch never starts the next agent with less supervision than that.",
      ]);
    }
    return { mode: request.startMode, permission: null };
  }
  const ceiling = settings.permission ?? "read-only";
  const level = request.permission ?? request.outgoingLevel ?? ceiling;
  if (RANK[level] > RANK[ceiling]) {
    throw new CommandError(ExitCode.WouldRaisePermission, [
      `This job allows ${ceiling}. relay switch never gives the next agent more than that.`,
    ]);
  }
  return { mode: request.startMode === "none" ? "none" : "headless", permission: level };
}
