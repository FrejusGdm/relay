// The one writer of config.toml (add-provider-adapters, design decision 10; the provider-accounts
// spec, "Writing config.toml safely"). It changes the text only by appending a whole table or
// removing one whole [accounts."<id>"] table, so the person's comments and order survive, and it
// saves nothing that does not pass the same checks as loading.
import { closeSync, constants, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../../cli/errors";
import { ExitCode } from "../../cli/exit-codes";
import { now } from "../../platform/clock";
import { parseToml } from "../../platform/toml";
import { readPrivateFile } from "../relay-home";
import type { AccountId, RelayConfig } from "./types";
import { validateConfig } from "./validate";

const MAX_CONFIG_BYTES = 1_048_576;
const ADDED_COMMENT = "# Added by relay on ";

export interface ConfigContext {
  relayHome: string;
  homedir: string;
  uid: number;
}

// Adds a blank line, a dated comment and the table at the end of the file.
export function appendTable(text: string, block: string, today: Date = now()): string {
  const date = [today.getFullYear(), today.getMonth() + 1, today.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  const table = block.endsWith("\n") ? block : `${block}\n`;
  const before = text === "" ? "" : `${text.endsWith("\n") ? text : `${text}\n`}\n`;
  return `${before}${ADDED_COMMENT}${date}.\n${table}`;
}

// Removes the line [accounts."<id>"], every following line up to the next line that starts a
// table, and a "# Added by relay" comment directly above it. An account written in another form,
// with dotted keys or as an inline table, is refused.
export function removeAccountTable(text: string, id: AccountId): string {
  const lines = text.split("\n");
  const header = `[accounts."${id}"]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    throw new CommandError(ExitCode.Failed, [
      `relay could not find the ${header} table in config.toml. Remove the account there yourself.`,
    ]);
  }
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trimStart().startsWith("[")) end++;
  let first = start;
  if (first > 0 && lines[first - 1]!.startsWith(ADDED_COMMENT)) first--;
  // At the end of the file, the blank line that separated the table goes too.
  const atEnd = end === lines.length;
  if (atEnd && first > 0 && lines[first - 1]!.trim() === "") first--;
  const kept = [...lines.slice(0, first), ...lines.slice(end)];
  if (atEnd && kept.length > 0 && kept.at(-1) !== "") kept.push("");
  return kept.join("\n");
}

// Reads config.toml (an empty text when it is missing), applies `change`, checks the result with
// the settings schema and writes it through a temporary file and a rename, with mode 0600. When
// the result does not pass, the file keeps its old bytes. Returns the new settings.
export function editConfig(
  ctx: ConfigContext,
  change: (text: string) => string,
  check: (config: RelayConfig) => boolean = () => true,
): RelayConfig {
  const file = join(ctx.relayHome, "config.toml");
  const before = readPrivateFile(file, ctx.uid, MAX_CONFIG_BYTES) ?? "";
  const after = change(before);
  let config: RelayConfig | null = null;
  try {
    const result = validateConfig(parseToml(after), { relayHome: ctx.relayHome, homedir: ctx.homedir });
    if (result.problems.length === 0 && check(result.config)) config = result.config;
  } catch {
    config = null;
  }
  if (config === null) {
    throw new CommandError(ExitCode.Internal, [
      "relay made a change to config.toml that does not pass its own checks. Nothing was saved. Please report this.",
    ]);
  }
  writeAtomically(file, after);
  return config;
}

function writeAtomically(file: string, text: string): void {
  const temporary = `${file}.tmp-${process.pid}`;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, flags, 0o600);
  try {
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
