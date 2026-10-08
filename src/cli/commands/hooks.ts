// relay hooks install | remove | status <account> (the provider-hook-setup spec).
import { checkProfileFolder, displayPath, ensureProfileFolder, ProfileError, usesProviderDefaultFolder } from "../../accounts/profile";
import { updateAccountRecord } from "../../accounts/record";
import { findAccount } from "../../accounts/registry";
import { createAdapterRegistry } from "../../adapters/registry";
import type { Account } from "../../core/config/types";
import { printable, quote } from "../../core/quote";
import { now } from "../../platform/clock";
import {
  addHooks, backupSettings, HookFileError, installStatusLine, isRelayStatusLine, plannedHooks, presentHooks,
  readSettingsFile, relayProgram, removeHooks, removeStatusLine, writeSettings,
} from "../../hooks/install";
import { join } from "node:path";
import { CommandError } from "../errors";
import { ExitCode } from "../exit-codes";
import type { CommandContext } from "./registry";

export type HookTrust = "trusted" | "untrusted" | "modified" | "unknown";

// Codex reports whether the person trusted relay's hooks; the Codex adapter reads it.
export type TrustReader = (account: Account, ctx: CommandContext) => Promise<HookTrust>;

const ACTIONS = ["install", "remove", "status"];

export function hooksCommand(readTrust?: TrustReader) {
  return async (ctx: CommandContext): Promise<number> => {
    const [action, id] = ctx.positionals as [string, string];
    try {
      if (!ACTIONS.includes(action)) throw usage(`relay: ${quote(action)} is not a hooks action. Use install, remove or status.`);
      if (action !== "install" && ctx.values["status-line"] !== undefined) throw usage(`relay: --status-line only works with relay hooks install.`);
      if (action === "status" && ctx.values.yes !== undefined) throw usage(`relay: --yes does not work with relay hooks status.`);
      const account = findAccount(ctx.config, id);
      if (account === undefined) {
        throw new CommandError(ExitCode.NoSuchAccount, [`${printable(id)} is not one of your accounts. See relay account list.`]);
      }
      if (action === "install") return await install(ctx, account, { statusLine: ctx.values["status-line"] === true });
      if (action === "remove") return await remove(ctx, account);
      return await status(ctx, account, readTrust);
    } catch (error) {
      if (error instanceof ProfileError) {
        ctx.io.err(`${error.message}\n`);
        return ExitCode.Settings;
      }
      if (error instanceof HookFileError) {
        ctx.io.err(`${error.message}\n`);
        return ExitCode.Failed;
      }
      if (error instanceof CommandError) {
        ctx.io.err(error.lines.map((line) => `${line}\n`).join(""));
        return error.code;
      }
      throw error;
    }
  };
}

function usage(line: string): CommandError {
  return new CommandError(ExitCode.Usage, [line, 'Run "relay hooks --help" for an example.']);
}

function out(ctx: CommandContext, lines: string[]): void {
  ctx.io.out(lines.map((line) => `${line}\n`).join(""));
}

async function confirm(ctx: CommandContext, question: string): Promise<void> {
  if (ctx.values.yes === true) return;
  if (!ctx.io.stdinIsTTY) {
    throw new CommandError(ExitCode.NeedsPerson, ["relay needs your answer. Run again in a terminal, or add --yes."]);
  }
  ctx.io.out(`${question} [y/N] `);
  const answer = (await ctx.io.readLine())?.trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") throw new CommandError(ExitCode.NeedsPerson, ["Nothing changed."]);
}

function settingsPath(ctx: CommandContext, account: Account) {
  const spec = createAdapterRegistry({}, ctx.env).get(account.provider).hookSpec();
  const path = join(account.profileDir, spec.file);
  return { spec, path, shown: printable(displayPath(path, ctx.homedir)) };
}

function program(ctx: CommandContext): string {
  const path = relayProgram(ctx.env);
  if (path === null) {
    throw new CommandError(ExitCode.Failed, [
      "relay hooks install needs the installed relay program. Set RELAY_BIN when running relay from source.",
    ]);
  }
  return path;
}

// Installs relay's hooks, and with statusLine its status-line wrapper, after showing them.
export async function install(ctx: CommandContext, account: Account, options: { statusLine: boolean }): Promise<number> {
  if (options.statusLine && account.provider !== "claude") {
    throw usage("relay: only Claude Code has a status line, so --status-line works only for Claude accounts.");
  }
  const relay = program(ctx);
  const uid = process.getuid!();
  checkProfileFolder(account.profileDir, uid, ctx.homedir);
  const { spec, path, shown } = settingsPath(ctx, account);
  const file = readSettingsFile(path, shown);
  const planned = plannedHooks(account.provider, spec, relay);
  const { added } = addHooks(file.data, account.provider, planned);
  const statusLineNeeded = options.statusLine && !isRelayStatusLine(file.data.statusLine);
  if (added.length === 0 && !statusLineNeeded) {
    out(ctx, [`relay's hooks are already installed for ${account.id}.`]);
    return ExitCode.Ok;
  }
  const width = Math.max(...added.map((hook) => hook.event.length)) + 2;
  out(ctx, [
    `relay will add these hooks to ${shown}:`,
    ...added.map((hook) => `  ${hook.event.padEnd(width)}${hook.command}  (time limit ${hook.timeout} s)`),
    ...(statusLineNeeded ? [`and set its status line to run relay first: ${printable(relay)} statusline claude`] : []),
  ]);
  await confirm(ctx, "Install these hooks?");

  ensureProfileFolder(account.profileDir, ctx.relayHome, uid, ctx.homedir);
  // Read again after the question, so a change the person made meanwhile is kept.
  const fresh = readSettingsFile(path, shown);
  let data = addHooks(fresh.data, account.provider, planned).data;
  let hadOriginal = false;
  if (statusLineNeeded) ({ data, hadOriginal } = installStatusLine(ctx.relayHome, account, data, relay));
  const backup = backupSettings(ctx.relayHome, account, fresh);
  writeSettings(fresh, data);
  const time = now().toISOString();
  updateAccountRecord(ctx.relayHome, account, {
    hooks_installed_at: time,
    ...(statusLineNeeded ? { status_line_installed_at: time } : {}),
  });
  ctx.log.info("hooks installed", { account: account.id, events: added.length, status_line: statusLineNeeded });
  out(ctx, [
    ...(backup === null ? [] : [`Saved a copy of the old file in ${printable(displayPath(backup, ctx.homedir))}.`]),
    `Installed relay's hooks for ${account.id}.`,
    ...(hadOriginal ? ["Your status line still shows; relay runs it after recording the usage numbers."] : []),
    ...(account.provider === "codex" ? [codexTrustHint(ctx, account)] : []),
  ]);
  return ExitCode.Ok;
}

function codexTrustHint(ctx: CommandContext, account: Account): string {
  const open = usesProviderDefaultFolder(account, ctx.homedir) ? "codex" : `CODEX_HOME=${printable(displayPath(account.profileDir, ctx.homedir))} codex`;
  return `Codex asks you to trust new hooks once. Open Codex with this account (${open}), type /hooks, and trust the relay hooks.`;
}

async function remove(ctx: CommandContext, account: Account): Promise<number> {
  checkProfileFolder(account.profileDir, process.getuid!(), ctx.homedir);
  const { path, shown } = settingsPath(ctx, account);
  const file = readSettingsFile(path, shown);
  const { removed } = removeHooks(file.data, account.provider);
  const statusLine = isRelayStatusLine(file.data.statusLine);
  if (removed === 0 && !statusLine) {
    out(ctx, [`relay's hooks are not installed for ${account.id}.`]);
    return ExitCode.Ok;
  }
  out(ctx, [`relay will remove its ${removed === 1 ? "hook" : `${removed} hooks`} from ${shown}${statusLine ? " and put back your status line" : ""}.`]);
  await confirm(ctx, "Remove relay's hooks?");
  const fresh = readSettingsFile(path, shown);
  let data = removeHooks(fresh.data, account.provider).data;
  data = removeStatusLine(ctx.relayHome, account, data).data;
  const backup = backupSettings(ctx.relayHome, account, fresh);
  writeSettings(fresh, data);
  updateAccountRecord(ctx.relayHome, account, { hooks_installed_at: null, status_line_installed_at: null });
  ctx.log.info("hooks removed", { account: account.id, entries: removed, status_line: statusLine });
  out(ctx, [
    ...(backup === null ? [] : [`Saved a copy of the old file in ${printable(displayPath(backup, ctx.homedir))}.`]),
    `Removed relay's hooks from ${account.id}.`,
  ]);
  return ExitCode.Ok;
}

async function status(ctx: CommandContext, account: Account, readTrust?: TrustReader): Promise<number> {
  checkProfileFolder(account.profileDir, process.getuid!(), ctx.homedir);
  const { spec, path, shown } = settingsPath(ctx, account);
  const file = readSettingsFile(path, shown);
  const present = presentHooks(file.data, account.provider, spec.events);
  const missing = spec.events.filter((event) => !present.includes(event));
  let summary: string;
  if (present.length === 0) summary = "not installed";
  else if (missing.length > 0) summary = `partly installed; missing ${missing.join(", ")}. Run relay hooks install ${account.id}.`;
  else summary = "installed";
  if (present.length > 0 && account.provider === "codex" && readTrust !== undefined) {
    const trust = await readTrust(account, ctx);
    if (trust === "trusted") summary += " and trusted";
    else if (trust === "untrusted") summary += ", waiting for you to trust them in Codex (/hooks).";
    else if (trust === "modified") summary += ", but changed since you trusted them. Trust them again in Codex (/hooks).";
    else summary += "; relay could not ask Codex whether you trusted them.";
  }
  const width = Math.max(...spec.events.map((event) => event.length)) + 2;
  out(ctx, [
    `${account.id}  ${shown}`,
    `Hooks: ${summary}`,
    ...spec.events.map((event) => `  ${event.padEnd(width)}${present.includes(event) ? "present" : "missing"}`),
    ...(account.provider === "claude" ? [`Status line: ${isRelayStatusLine(file.data.statusLine) ? "installed" : "not installed"}`] : []),
  ]);
  return ExitCode.Ok;
}
