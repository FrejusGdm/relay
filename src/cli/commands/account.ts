// relay account list | add | status | login | remove (the provider-accounts spec). relay signs in
// only by running the provider's own login in the person's terminal, and keeps only whether the
// account is signed in and the method the provider reported.
import { buildAgentEnv } from "../../accounts/environment";
import { forgetAvailability, readAvailability } from "../../accounts/availability";
import { checkProfileFolder, displayPath, ensureProfileFolder, ProfileError, usesProviderDefaultFolder } from "../../accounts/profile";
import { authFact, readAccountRecord, startAccountRecord, updateAccountRecord } from "../../accounts/record";
import {
  ACCOUNT_NAME, accountReferences, defaultProfileDir, findAccount, isProvider, splitAccountArgs,
} from "../../accounts/registry";
import { findProgram } from "../../adapters/program";
import { foldSpool } from "../../hooks/fold";
import { relayProgram } from "../../hooks/install";
import { runInTerminal } from "../../adapters/process";
import { createAdapterRegistry } from "../../adapters/registry";
import { tomlString } from "../../adapters/text";
import type { Availability, ProviderAdapter } from "../../adapters/types";
import { appendTable, editConfig, removeAccountTable } from "../../core/config/edit";
import type { Account, AccountId } from "../../core/config/types";
import { expandPath } from "../../core/paths";
import { printable, quote } from "../../core/quote";
import { now } from "../../platform/clock";
import { policyOf } from "../../policies/load";
import { CommandError, needsAnswer } from "../errors";
import { ExitCode } from "../exit-codes";
import { install as installHooks } from "./hooks";
import { termLines } from "./policy";
import type { CommandContext } from "./registry";

const ACTION_OPTIONS: Record<string, string[]> = {
  list: ["json"],
  add: ["profile-dir", "api-key-env", "kind", "no-login", "yes"],
  status: ["json"],
  login: [],
  remove: ["yes"],
};
// The credential variables each provider's account may name, as in src/accounts/environment.ts.
const CREDENTIAL_NAMES = {
  claude: { pattern: /^(?:ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_OAUTH_TOKEN)$/, hint: "ANTHROPIC_ variables or CLAUDE_CODE_OAUTH_TOKEN" },
  codex: { pattern: /^(?:OPENAI_[A-Z0-9_]+|CODEX_(?!HOME$)[A-Z0-9_]+)$/, hint: "OPENAI_ or CODEX_ variables other than CODEX_HOME" },
} as const;
const PROFILE_VARIABLE = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;
const LOGOUT = { claude: "claude auth logout", codex: "codex logout" } as const;

export async function account(ctx: CommandContext): Promise<number> {
  const [action, ...rest] = ctx.positionals as [string, ...string[]];
  try {
    const allowed = ACTION_OPTIONS[action];
    if (allowed === undefined) {
      throw usage(`relay: ${quote(action)} is not an account action. Use list, add, status, login or remove.`);
    }
    for (const name of Object.keys(ctx.values)) {
      if (!allowed.includes(name)) throw usage(`relay: --${name} does not work with relay account ${action}.`);
    }
    switch (action) {
      case "list":
        if (rest.length > 0) throw usage("relay: relay account list takes no account.");
        return list(ctx);
      case "add":
        return await add(ctx, rest);
      case "status":
        return await status(ctx, existing(ctx, rest));
      case "login":
        return await login(ctx, existing(ctx, rest));
      default:
        return await remove(ctx, existing(ctx, rest));
    }
  } catch (error) {
    if (error instanceof ProfileError) {
      ctx.io.err(`${error.message}\n`);
      return ExitCode.Settings;
    }
    if (error instanceof CommandError) {
      ctx.io.err(error.lines.map((line) => `${line}\n`).join(""));
      return error.code;
    }
    throw error;
  }
}

function usage(line: string): CommandError {
  return new CommandError(ExitCode.Usage, [line, 'Run "relay account --help" for an example.']);
}

function adapters(ctx: CommandContext) {
  return createAdapterRegistry({}, ctx.env);
}

// The account named by "<provider:name>" or "<provider> <name>", which must be in config.toml.
function existing(ctx: CommandContext, args: string[]): Account {
  const parts = splitAccountArgs(args);
  if (parts === null) throw usage("relay: name the account as <provider:name>, for example claude:work.");
  const id = `${parts.provider}:${parts.name}`;
  const found = findAccount(ctx.config, id);
  if (found === undefined) {
    throw new CommandError(ExitCode.NoSuchAccount, [`${printable(id)} is not one of your accounts. See relay account list.`]);
  }
  return found;
}

function show(ctx: CommandContext, path: string): string {
  return printable(displayPath(path, ctx.homedir));
}

function lines(ctx: CommandContext, text: string[]): void {
  ctx.io.out(text.map((line) => `${line}\n`).join(""));
}

async function confirm(ctx: CommandContext, question: string): Promise<void> {
  if (ctx.values.yes === true) return;
  if (!ctx.io.stdinIsTTY) throw needsAnswer(question);
  ctx.io.out(`${question} [y/N] `);
  const answer = (await ctx.io.readLine())?.trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") throw new CommandError(ExitCode.NeedsPerson, ["Nothing changed."]);
}

async function add(ctx: CommandContext, args: string[]): Promise<number> {
  if (args.length !== 2) throw usage("relay: relay account add needs <provider> <name>, for example relay account add claude work.");
  const [provider, name] = args as [string, string];
  if (!isProvider(provider)) {
    throw new CommandError(ExitCode.Usage, [`relay has no adapter for ${printable(provider)} yet. Supported providers: claude, codex.`]);
  }
  if (!ACCOUNT_NAME.test(name)) {
    throw usage(`relay: ${quote(name)} cannot be an account name. Use 1 to 32 lowercase letters, digits and "-", starting with a letter or digit.`);
  }
  const id = `${provider}:${name}` as AccountId;
  if (findAccount(ctx.config, id) !== undefined) {
    throw new CommandError(ExitCode.Usage, [`${id} already exists. See relay account list.`]);
  }
  const kind = ctx.values.kind;
  if (kind !== undefined && kind !== "personal" && kind !== "work") throw usage("relay: --kind must be personal or work.");
  const keys = (ctx.values["api-key-env"] as string[] | undefined) ?? [];
  for (const key of keys) {
    if (!CREDENTIAL_NAMES[provider].pattern.test(key)) {
      throw usage(`relay: ${provider} accounts can only pass ${CREDENTIAL_NAMES[provider].hint}, not ${quote(key)}.`);
    }
  }
  const givenDir = ctx.values["profile-dir"] as string | undefined;
  const profileDir = givenDir === undefined ? defaultProfileDir(ctx.relayHome, provider, name) : expandPath(givenDir, ctx.homedir);
  if (profileDir === null) throw usage("relay: --profile-dir must be an absolute path or start with ~/.");
  const owner = ctx.config.accounts.find((other) => other.profileDir === profileDir);
  if (owner !== undefined) {
    throw new CommandError(ExitCode.Usage, [
      `${show(ctx, profileDir)} is already the profile folder of ${owner.id}. Each account needs its own profile folder.`,
    ]);
  }
  const uid = process.getuid!();
  checkProfileFolder(profileDir, uid, ctx.homedir);
  const adapter = adapters(ctx).get(provider);
  const detection = await adapter.detect();
  if (!detection.installed) {
    throw new CommandError(ExitCode.ProviderMissing, [`${adapter.displayName} is not installed. Install it, then run relay account add again.`]);
  }
  // Refused before the policy notes are printed, so a script sees only the refusal.
  if (ctx.values.yes !== true && !ctx.io.stdinIsTTY) throw needsAnswer(`Add ${id}?`);

  const policy = policyOf(provider);
  lines(ctx, [`${policy.displayName} policy notes, checked ${policy.checkedOn}:`, policy.summary, ...termLines(policy), ""]);
  await confirm(ctx, `Add ${id}?`);

  ensureProfileFolder(profileDir, ctx.relayHome, uid, ctx.homedir);
  const table = [
    `[accounts."${id}"]`,
    ...(kind === undefined ? [] : [`kind = "${kind}"`]),
    ...(givenDir === undefined ? [] : [`profile_dir = ${tomlString(profileDir)}`]),
    ...(keys.length === 0 ? [] : [`credential_env = [${keys.map((key) => `"${key}"`).join(", ")}]`]),
  ].join("\n");
  const config = editConfig(
    { relayHome: ctx.relayHome, homedir: ctx.homedir, uid },
    (text) => appendTable(text, table),
    (result) => findAccount(result, id) !== undefined,
  );
  const added = findAccount(config, id)!;
  const time = now().toISOString();
  startAccountRecord(ctx.relayHome, added, { added_at: time, policy_checked_on_seen: policy.checkedOn, policy_seen_at: time });
  forgetAvailability(ctx.relayHome, added);
  ctx.log.info("account added", { account: id, provider, api_key: keys.length > 0 });

  const summary = [`Added ${id}.`, `  Profile    ${show(ctx, profileDir)}`];
  if (keys.length > 0) {
    lines(ctx, [...summary, ...keys.map((key) =>
      `${id} uses the key in $${key}. relay passes that variable to ${adapter.displayName} and never stores its value.`)]);
    return offerHooks(ctx, added, givenDir === undefined);
  }
  let signedIn = await checkSignIn(ctx, adapter, added);
  if (!signedIn.signedIn && ctx.values["no-login"] !== true) {
    signedIn = await runLogin(ctx, adapter, added);
    if (!signedIn.signedIn) {
      throw new CommandError(ExitCode.NotSignedIn, [
        `${adapter.displayName} sign-in did not finish. The account is added; sign in later with relay account login ${id}.`,
      ]);
    }
  }
  lines(ctx, [...summary, `  Signed in  ${signedInText(signedIn)}`]);
  if (!signedIn.signedIn) lines(ctx, [`Sign in later with relay account login ${id}.`]);
  return offerHooks(ctx, added, givenDir === undefined);
}

// relay offers its hooks only for a profile folder it created, and only when it can ask. For any
// other folder they are installed only by relay hooks install (the provider-hook-setup spec).
async function offerHooks(ctx: CommandContext, added: Account, relayFolder: boolean): Promise<number> {
  const hint = `To let relay see sessions you start yourself, run relay hooks install ${added.id}.`;
  if (!relayFolder || ctx.values.yes === true || !ctx.io.stdinIsTTY || relayProgram(ctx.env) === null) {
    lines(ctx, [hint]);
    return ExitCode.Ok;
  }
  ctx.io.out("Install relay's hooks, so relay can see sessions you start yourself? [y/N] ");
  const answer = (await ctx.io.readLine())?.trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    lines(ctx, [hint]);
    return ExitCode.Ok;
  }
  return installHooks({ ...ctx, values: { ...ctx.values, yes: true } }, added, { statusLine: false });
}

function signedInText(status: { signedIn: boolean; method?: string | null }): string {
  if (!status.signedIn) return "no";
  return status.method ? `yes (${printable(status.method)})` : "yes";
}

// Runs the provider's status command for the account and records the result.
async function checkSignIn(ctx: CommandContext, adapter: ProviderAdapter, target: Account) {
  const result = await adapter.authStatus(target, buildAgentEnv(target, ctx.env));
  updateAccountRecord(ctx.relayHome, target, { last_auth: authFact(result) });
  return result;
}

// Runs the provider's own login attached to the person's terminal, with the account's environment,
// then checks the result with the status command.
async function runLogin(ctx: CommandContext, adapter: ProviderAdapter, target: Account) {
  const path = findProgram(target.provider, ctx.env);
  if (path === null) {
    throw new CommandError(ExitCode.ProviderMissing, [`${adapter.displayName} is not installed. Install it, then try again.`]);
  }
  const [, ...args] = adapter.loginCommand(target);
  ctx.log.info("login started", { account: target.id });
  const exit = await runInTerminal({ path, args, cwd: ctx.cwd, env: buildAgentEnv(target, ctx.env) });
  ctx.log.info("login finished", { account: target.id, exit_code: exit.code });
  if (exit.code !== 0) {
    updateAccountRecord(ctx.relayHome, target, { last_auth: authFact({ signedIn: false }) });
    return { signedIn: false };
  }
  return checkSignIn(ctx, adapter, target);
}

function list(ctx: CommandContext): number {
  const rows = ctx.config.accounts.map((entry) => {
    const record = readAccountRecord(ctx.relayHome, entry);
    const installed = findProgram(entry.provider, ctx.env) !== null;
    return { entry, record, installed };
  });
  if (ctx.values.json === true) {
    lines(ctx, [JSON.stringify({
      accounts: rows.map(({ entry, record, installed }) => ({
        id: entry.id, provider: entry.provider, name: entry.name, kind: entry.kind,
        profile_dir: entry.profileDir, credential_env: entry.credentialEnv, installed,
        signed_in: record.last_auth?.signed_in ?? null, method: record.last_auth?.method ?? null,
        checked_at: record.last_auth?.checked_at ?? null,
      })),
    })]);
    return ExitCode.Ok;
  }
  if (rows.length === 0) {
    lines(ctx, ["You have no accounts yet. Add one with relay account add <provider> <name>."]);
    return ExitCode.Ok;
  }
  const idWidth = Math.max(...rows.map(({ entry }) => entry.id.length)) + 3;
  const pathWidth = Math.max(...rows.map(({ entry }) => show(ctx, entry.profileDir).length)) + 3;
  lines(ctx, rows.map(({ entry, record, installed }) => {
    const auth = entry.credentialEnv.length > 0
      ? `API key ($${entry.credentialEnv.join(", $")})`
      : record.last_auth === null ? "sign-in not checked yet"
        : record.last_auth.signed_in ? `signed in${record.last_auth.method ? ` (${printable(record.last_auth.method)})` : ""}`
          : "not signed in";
    const program = installed ? "" : `, ${entry.provider} is not installed`;
    return `${entry.id.padEnd(idWidth)}${show(ctx, entry.profileDir).padEnd(pathWidth)}${auth}${program}`;
  }));
  return ExitCode.Ok;
}

async function login(ctx: CommandContext, target: Account): Promise<number> {
  ensureProfileFolder(target.profileDir, ctx.relayHome, process.getuid!(), ctx.homedir);
  const adapter = adapters(ctx).get(target.provider);
  const result = await runLogin(ctx, adapter, target);
  if (!result.signedIn) {
    throw new CommandError(ExitCode.NotSignedIn, [
      `${adapter.displayName} sign-in did not finish. Try again with relay account login ${target.id}.`,
    ]);
  }
  lines(ctx, [`${target.id} is signed in.`]);
  return ExitCode.Ok;
}

const STATE_TEXT: Record<Availability["state"], string> = {
  available: "available",
  rate_limited: "rate limited",
  quota_exhausted: "limit",
  unavailable: "unavailable",
  unknown: "unknown",
};
const SOURCE_TEXT: Record<Availability["source"], string> = {
  provider_api: "provider",
  stream_event: "agent output",
  hook: "hook",
  status_line: "status line",
  message_text: "agent message",
  user: "you",
  none: "no reading",
};

async function status(ctx: CommandContext, target: Account): Promise<number> {
  checkProfileFolder(target.profileDir, process.getuid!(), ctx.homedir);
  const adapter = adapters(ctx).get(target.provider);
  const installed = findProgram(target.provider, ctx.env) !== null;
  const auth = target.credentialEnv.length > 0 || !installed ? null : await checkSignIn(ctx, adapter, target);
  foldSpool(ctx.relayHome, ctx.config, target, ctx.homedir);
  // Codex gives a live reading through its app server (design decision 9); it is recorded first.
  if (target.provider === "codex" && installed) await adapter.availability(target, buildAgentEnv(target, ctx.env));
  const record = readAccountRecord(ctx.relayHome, target);
  const availability = readAvailability(ctx.relayHome, target);
  if (ctx.values.json === true) {
    lines(ctx, [JSON.stringify({
      account: target.id, profile_dir: target.profileDir, installed, credential_env: target.credentialEnv,
      signed_in: auth?.signedIn ?? null, method: auth?.method ?? null,
      availability: {
        state: availability.state, retry_at: availability.retryAt?.toISOString() ?? null,
        observed_at: availability.source === "none" ? null : availability.observedAt.toISOString(),
        source: availability.source, detail: availability.detail ?? null,
        windows: availability.windows.map((window) => ({
          name: window.name, window_minutes: window.windowMinutes ?? null, used_percent: window.usedPercent ?? null,
          resets_at: window.resetsAt?.toISOString() ?? null, source: window.source,
        })),
      },
      hooks_installed: record.hooks_installed_at !== null,
      status_line_installed: target.provider === "claude" ? record.status_line_installed_at !== null : null,
    })]);
    return ExitCode.Ok;
  }
  const signedIn = target.credentialEnv.length > 0 ? `API key ($${target.credentialEnv.join(", $")})`
    : auth === null ? `unknown (${adapter.displayName} is not installed)` : signedInText(auth);
  const row = (label: string, value: string) => `  ${label.padEnd(14)}${value}`;
  lines(ctx, [
    target.id,
    row("Profile", show(ctx, target.profileDir) + (usesProviderDefaultFolder(target, ctx.homedir) ? ` (${adapter.displayName}'s own folder)` : "")),
    row("Signed in", signedIn),
    row("Availability", availabilityText(availability)),
    row("Hooks", record.hooks_installed_at === null ? "not installed" : "installed"),
    ...(target.provider === "claude" ? [row("Status line", record.status_line_installed_at === null ? "not installed" : "installed")] : []),
  ]);
  return ExitCode.Ok;
}

function availabilityText(reading: Availability): string {
  if (reading.source === "none") return "unknown (no reading yet)";
  let text = STATE_TEXT[reading.state];
  if (reading.retryAt !== undefined) text += `, resets ${clockText(reading.retryAt)}`;
  text += ` (${SOURCE_TEXT[reading.source]}, ${ageText(reading.observedAt)})`;
  if (reading.detail !== undefined) text += `. ${printable(reading.detail)}`;
  return text;
}

// 24-hour local time, with the weekday when the time is not today (design decision 19).
function clockText(time: Date): string {
  const today = now();
  const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
  const sameDay = time.toDateString() === today.toDateString();
  return sameDay ? clock : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][time.getDay()]} ${clock}`;
}

function ageText(time: Date): string {
  const minutes = Math.floor((now().getTime() - time.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

async function remove(ctx: CommandContext, target: Account): Promise<number> {
  const references = accountReferences(ctx.config, target.id);
  if (references.projects.length > 0) {
    throw new CommandError(ExitCode.Usage, [
      `${target.id} is allowed on ${printable(references.projects[0]!)}. Remove it from that project's allow list in config.toml first.`,
    ]);
  }
  if (references.other) {
    throw new CommandError(ExitCode.Usage, [
      `${target.id} is named in [defaults], [t3] or [limits] in config.toml. Remove it there first.`,
    ]);
  }
  await confirm(ctx, `Remove ${target.id} from config.toml?`);
  editConfig(
    { relayHome: ctx.relayHome, homedir: ctx.homedir, uid: process.getuid!() },
    (text) => removeAccountTable(text, target.id),
    (result) => findAccount(result, target.id) === undefined,
  );
  ctx.log.info("account removed", { account: target.id });
  const folder = show(ctx, target.profileDir);
  if (usesProviderDefaultFolder(target, ctx.homedir)) {
    lines(ctx, [`Removed ${target.id}. It used ${folder}, which relay leaves as it is.`]);
  } else {
    lines(ctx, [
      `Removed ${target.id}. Its profile folder is still at ${folder}. To sign out, run ` +
        `${PROFILE_VARIABLE[target.provider]}=${folder} ${LOGOUT[target.provider]}, then delete the folder yourself.`,
    ]);
  }
  return ExitCode.Ok;
}
