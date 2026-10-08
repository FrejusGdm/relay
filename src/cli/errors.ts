// Each error carries the lines relay prints to standard error.

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
