// Each error carries the lines relay prints to standard error.
import { ExitCode } from "./exit-codes";

export class UsageError extends Error {
  constructor(readonly lines: string[]) {
    super(lines[0]);
    this.name = "UsageError";
  }
}

// problems is the number of problems found, which the log records instead of the lines.
export class SettingsError extends Error {
  constructor(
    readonly lines: string[],
    readonly problems = 1,
  ) {
    super(lines[0]);
    this.name = "SettingsError";
  }
}

// A command that stops for a known reason: the exit code from exit-codes.ts and the lines for
// standard error, written exactly as the specs give them.
export class CommandError extends Error {
  constructor(
    readonly code: number,
    readonly lines: string[],
  ) {
    super(lines[0]);
    this.name = "CommandError";
  }
}

// A yes-or-no question with no terminal to ask it in and no --yes: the refusal names the question.
export function needsAnswer(question: string): CommandError {
  return new CommandError(ExitCode.NeedsPerson, [
    `relay needs your yes to the question "${question}" and has no terminal to ask it in.`,
    "Run the command again in a terminal, or add --yes.",
  ]);
}
