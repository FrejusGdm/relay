import type { LogLevel, RelayConfig } from "../../core/config/types";
import type { Logger } from "../../core/log";
import type { Io } from "../io";
import { buildAgentEnv } from "../../accounts/environment";
import { readCodexHookTrust } from "../../adapters/codex/hooks";
import { acceptGitChanges } from "./accept-git-changes";
import { account } from "./account";
import { checkpoint } from "./checkpoint";
import { checkpoints } from "./checkpoints";
import { daemon } from "./daemon";
import { hook } from "./hook";
import { hooksCommand } from "./hooks";
import { init } from "./init";
import { notBuilt } from "./not-built";
import { policy } from "./policy";
import { providers } from "./providers";
import { rollback } from "./rollback";
import { run } from "./run";
import { switchCommand } from "./switch";
import { statusline, statuslineWithoutSettings } from "./statusline";

export type CommandName = "init" | "run" | "checkpoint" | "checkpoints" | "rollback"
  | "accept-git-changes" | "switch" | "status" | "account" | "providers" | "policy"
  | "hooks" | "hook" | "statusline" | "daemon" | "doctor";

export interface OptionDef {
  name: string;          // long name without dashes, for example "message"
  short?: string;        // one letter, for example "m"
  value?: string;        // placeholder when the option takes a value, for example "<text>"
  multiple?: boolean;    // the option may be given more than once; its value is then a list
  description: string;
}

export interface CommandContext {
  def: CommandDef;
  positionals: string[];
  values: Record<string, string | boolean | string[] | undefined>;
  io: Io;
  log: Logger;
  logLevel: LogLevel;    // from --log-level, RELAY_LOG_LEVEL or the settings, for logs a command opens
  // The folder relay was started in, the environment, the home folder and the checked relay folder.
  cwd: string;
  env: Record<string, string | undefined>;
  homedir: string;
  relayHome: string;
  config: RelayConfig;
}

export interface CommandDef {
  name: CommandName;
  usage: string;         // "relay switch <provider[:account]>"
  argsUsage: string;     // "<provider[:account]>", used in "needs ..." messages; "" when none
  summary: string;       // one line, no final period
  details: string[];     // lines printed after the summary
  examples: string[];
  options: OptionDef[];  // the command's own options
  minArgs: number;
  maxArgs: number;
  quiet: boolean;        // true for hook and statusline: no output of relay's own, always exit 0
  built: boolean;        // false until a change builds the command
  handler: (ctx: CommandContext) => Promise<number>;
  // Runs in place of the settings error when config.toml is invalid.
  withoutSettings?: (ctx: Omit<CommandContext, "config">) => Promise<number>;
}

// Each later change that builds a command replaces its handler, sets `built`, adds its options,
// and updates its golden help file in test/cli/golden/ and docs/cli.md.
export const COMMANDS: CommandDef[] = [
  {
    name: "init",
    usage: "relay init [--title <text>]",
    argsUsage: "",
    summary: "Set up .relay/ in this project",
    details: ["relay creates the .relay/ folder for a job and keeps it out of your commits."],
    examples: ["relay init", 'relay init --title "Build authentication"'],
    options: [{ name: "title", value: "<text>", description: "A short name for the job" }],
    minArgs: 0,
    maxArgs: 0,
    quiet: false,
    built: true,
    handler: init,
  },
  {
    name: "run",
    usage: "relay run [<provider[:account]>] [--headless] [--prompt <text> | --prompt-file <path>] [--resume <id> | --resume last] [--permission <level>] [--model <name>] [--json] [--check <command>]... [--yes] [--no-summary]",
    argsUsage: "[<provider[:account]>]",
    summary: "Start an agent inside a relay job",
    details: [
      "Without an account, relay uses defaults.account from your settings.",
      "The agent works in your terminal, or with --headless on its own, and relay records what it did.",
    ],
    examples: [
      "relay run",
      "relay run claude:personal",
      'relay run codex:personal --headless --prompt "Fix the failing test."',
      "relay run claude:personal --resume last",
    ],
    options: [
      { name: "headless", description: "Run the agent without your terminal" },
      { name: "prompt", value: "<text>", description: "The first message for the agent" },
      { name: "prompt-file", value: "<path>", description: "Read the first message from a file" },
      { name: "resume", value: "<id>", description: "Continue a session, or the last one with last" },
      { name: "permission", value: "<level>", description: "headless: read-only or edit-in-workspace" },
      { name: "model", value: "<name>", description: "The model the agent uses" },
      { name: "json", description: "headless: print each worker event as JSON" },
      { name: "check", value: "<command>", multiple: true, description: "A check relay runs at every handoff (\"\" clears them)" },
      { name: "yes", description: "Answer yes to relay's own questions" },
      { name: "no-summary", description: "Do not ask the previous agent for handoff notes" },
    ],
    minArgs: 0,
    maxArgs: 1,
    quiet: false,
    built: true,
    handler: run,
  },
  {
    name: "checkpoint",
    usage: "relay checkpoint [-m <text>] [--include <path>]... [--json]",
    argsUsage: "",
    summary: "Save the job so another agent can continue it",
    details: [
      "relay saves your files as a commit under refs/relay/.",
      "Your branch and staged changes stay as they are.",
    ],
    examples: ['relay checkpoint -m "OAuth callback works"', "relay checkpoint --include .env.local"],
    options: [
      { name: "message", short: "m", value: "<text>", description: "A short summary of what changed" },
      { name: "include", value: "<path>", multiple: true, description: "Save a file whose name suggests secrets" },
      { name: "json", description: "Print the result as JSON" },
    ],
    minArgs: 0,
    maxArgs: 0,
    quiet: false,
    built: true,
    handler: checkpoint,
  },
  {
    name: "checkpoints",
    usage: "relay checkpoints [--json]",
    argsUsage: "",
    summary: "List the job's checkpoints",
    details: ["Newest first."],
    examples: ["relay checkpoints", "relay checkpoints --json"],
    options: [{ name: "json", description: "Print the list as JSON" }],
    minArgs: 0,
    maxArgs: 0,
    quiet: false,
    built: true,
    handler: checkpoints,
  },
  {
    name: "rollback",
    usage: "relay rollback [<checkpoint>] [--yes] [--dry-run]",
    argsUsage: "[<checkpoint>]",
    summary: "Return the files to an earlier checkpoint",
    details: [
      "relay shows which files will change and saves your current files first, so you can undo it.",
      "Your branch, commits and staged changes stay as they are.",
      "Without a checkpoint, relay uses the newest one not saved before a rollback.",
    ],
    examples: ["relay rollback", "relay rollback 3 --dry-run", "relay rollback 3 --yes"],
    options: [
      { name: "yes", description: "Roll back without asking" },
      { name: "dry-run", description: "Show what would change, and change nothing" },
    ],
    minArgs: 0,
    maxArgs: 1,
    quiet: false,
    built: true,
    handler: rollback,
  },
  {
    name: "accept-git-changes",
    usage: "relay accept-git-changes",
    argsUsage: "",
    summary: "Trust a change to git settings or hooks after you check it",
    details: ["Run it yourself in a terminal. It asks for your answer, so agents cannot run it."],
    examples: ["relay accept-git-changes"],
    options: [],
    minArgs: 0,
    maxArgs: 0,
    quiet: false,
    built: true,
    handler: acceptGitChanges,
  },
  {
    name: "switch",
    usage: "relay switch <provider[:account]>",
    argsUsage: "<provider[:account]>",
    summary: "Hand the job to another agent or account",
    details: [
      "relay stops the current agent, saves a checkpoint, writes the handoff and starts the next agent.",
      "The first handoff to an account asks first, because it sends your code to that account's company.",
    ],
    examples: ["relay switch codex:personal", "relay switch claude:startup", "relay switch codex:personal --no-start"],
    options: [
      { name: "yes", description: "Answer yes to relay's own questions" },
      { name: "no-summary", description: "Do not ask the current agent for handoff notes" },
      { name: "no-start", description: "Prepare the handoff without starting the next agent" },
      { name: "json", description: "Print the result as one JSON object" },
      { name: "check", value: "<command>", multiple: true, description: "A check relay runs at every handoff (\"\" clears them)" },
      { name: "permission", value: "<level>", description: "headless jobs: read-only or edit-in-workspace" },
    ],
    minArgs: 1,
    maxArgs: 1,
    quiet: false,
    built: true,
    handler: switchCommand,
  },
  {
    name: "status",
    usage: "relay status",
    argsUsage: "",
    summary: "Show the job, its workers, accounts and checkpoints",
    details: [],
    examples: ["relay status"],
    options: [],
    minArgs: 0,
    maxArgs: 0,
    quiet: false,
    built: false,
    handler: notBuilt,
  },
  {
    name: "account",
    usage: "relay account <list|add|status|login|remove> [<provider> <name> | <provider:name>]",
    argsUsage: "<list|add|status|login|remove> [<provider> <name> | <provider:name>]",
    summary: "Add, list, check, sign in to or remove accounts",
    details: [
      "Each account has its own profile folder.",
      "Signing in runs the provider's own login. relay never sees your password or token.",
    ],
    examples: [
      "relay account list",
      "relay account add codex work",
      "relay account add claude personal --profile-dir ~/.claude",
      "relay account add claude api --api-key-env ANTHROPIC_API_KEY",
      "relay account status claude:personal",
      "relay account login codex:work",
      "relay account remove codex:work",
    ],
    options: [
      { name: "profile-dir", value: "<dir>", description: "add: use this folder as the profile" },
      { name: "api-key-env", value: "<VAR>", multiple: true, description: "add: pass this key variable" },
      { name: "kind", value: "<kind>", description: "add: personal or work" },
      { name: "no-login", description: "add: do not sign in now" },
      { name: "yes", description: "add, remove: do not ask" },
      { name: "json", description: "list, status: print JSON" },
    ],
    minArgs: 1,
    maxArgs: 3,
    quiet: false,
    built: true,
    handler: account,
  },
  {
    name: "providers",
    usage: "relay providers [--json]",
    argsUsage: "",
    summary: "Show which agent programs are installed",
    details: ["relay runs each program's --version and lists what relay can do with it."],
    examples: ["relay providers", "relay providers --json"],
    options: [{ name: "json", description: "Print the result as JSON" }],
    minArgs: 0,
    maxArgs: 0,
    quiet: false,
    built: true,
    handler: providers,
  },
  {
    name: "policy",
    usage: "relay policy show <provider>",
    argsUsage: "show <provider>",
    summary: "Show relay's notes on a provider's terms",
    details: [],
    examples: ["relay policy show claude"],
    options: [],
    minArgs: 2,
    maxArgs: 2,
    quiet: false,
    built: true,
    handler: policy,
  },
  {
    name: "hooks",
    usage: "relay hooks <install|remove|status> <provider:name>",
    argsUsage: "<install|remove|status> <provider:name>",
    summary: "Add, remove or check relay's hooks for an account",
    details: ["Hooks let relay see when an agent stops or reaches a limit."],
    examples: [
      "relay hooks install claude:personal",
      "relay hooks install claude:personal --status-line",
      "relay hooks status codex:personal",
      "relay hooks remove claude:personal",
    ],
    options: [
      { name: "status-line", description: "install: also record usage from Claude Code's status line" },
      { name: "yes", description: "install, remove: do not ask" },
    ],
    minArgs: 2,
    maxArgs: 2,
    quiet: false,
    built: true,
    handler: hooksCommand((account, ctx) => readCodexHookTrust(account, buildAgentEnv(account, ctx.env), ctx.homedir)),
  },
  {
    name: "hook",
    usage: "relay hook <provider> <event>",
    argsUsage: "<provider> <event>",
    summary: "Pass an event from an agent's hooks to relay",
    details: [
      "Claude Code and Codex call this command from their hooks.",
      "You do not need to run it yourself.",
    ],
    examples: ["relay hook claude Stop"],
    options: [],
    minArgs: 2,
    maxArgs: 2,
    quiet: true,
    built: true,
    handler: hook,
  },
  {
    name: "statusline",
    usage: "relay statusline <provider>",
    argsUsage: "<provider>",
    summary: "Record usage from Claude Code's status line",
    details: [
      "Claude Code runs this command when you install relay's status line.",
      "You do not need to run it yourself.",
    ],
    examples: ["relay statusline claude"],
    options: [],
    minArgs: 1,
    maxArgs: 1,
    quiet: true,
    built: true,
    handler: statusline,
    withoutSettings: statuslineWithoutSettings,
  },
  {
    name: "daemon",
    usage: "relay daemon <start|stop|restart|status|run>",
    argsUsage: "<start|stop|restart|status|run>",
    summary: "Start, stop or check relay's background service",
    details: [
      "The service keeps live job state and listens only on a private socket in your relay folder.",
      "relay starts it by itself when a command needs it.",
    ],
    examples: ["relay daemon status"],
    options: [],
    minArgs: 1,
    maxArgs: 1,
    quiet: false,
    built: true,
    handler: daemon,
  },
  {
    name: "doctor",
    usage: "relay doctor --reindex",
    argsUsage: "",
    summary: "Rebuild relay's index of jobs",
    details: [
      "relay rebuilds the index from the .relay/ files and git, so nothing about your jobs is lost.",
    ],
    examples: ["relay doctor --reindex"],
    options: [{ name: "reindex", description: "Rebuild the index from the job files" }],
    minArgs: 0,
    maxArgs: 0,
    quiet: false,
    built: false,
    handler: notBuilt,
  },
];
