import { join } from "node:path";
import { credentialNameProblem } from "../../accounts/environment";
import { PROVIDERS, type Provider } from "../../adapters/providers";
import { expandPath } from "../paths";
import { quote } from "../quote";
import {
  LIMIT_ACTIONS, LIMIT_WINDOWS, LOG_LEVELS, type AccountId, type ConfigProblem,
  type LimitAction, type LimitSetting, type LimitWindow, type LogLevel, type RelayConfig,
} from "./types";

const ACCOUNT_ID = /^([a-z]+):([a-z0-9][a-z0-9-]{0,31})$/;
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const CREDENTIAL_WORDS = ["token", "apikey", "api_key", "password", "secret", "cookie", "credential"];

const UNKNOWN = "unknown setting.";
const CREDENTIAL =
  "relay never stores credentials. Remove this key and sign in with the provider's own login command.";
const ACCOUNT_NAME_FORM = 'account names look like provider:name in lowercase, for example "claude:personal".';
const PATH_FORM = "must be an absolute path or start with ~/.";
const STRING = "must be a string.";
const TABLE = "must be a table.";

type Table = Record<string, unknown>;
type Handlers = Record<string, (key: string, value: unknown) => void>;

export function emptyConfig(relayHome: string): RelayConfig {
  return {
    file: join(relayHome, "config.toml"),
    exists: false,
    version: 1,
    defaults: { account: null },
    log: { level: null },
    checkpoint: { maxFileSizeMb: 20 },
    accounts: [],
    projects: [],
    t3: { url: "http://127.0.0.1:3773/mcp", projects: [], instances: [] },
    limits: [],
    handoff: { askForSummary: true, summaryTimeoutSeconds: 120, stopTimeoutSeconds: 30, checkTimeoutSeconds: 600, startCheckSeconds: 5 },
  };
}

// Walks the parsed settings in file order and collects every problem. A problem names the key and
// never shows the value, except an account name that has the provider:name form.
export function validateConfig(
  raw: unknown,
  ctx: { relayHome: string; homedir: string },
): { config: RelayConfig; problems: ConfigProblem[] } {
  const config: RelayConfig = { ...emptyConfig(ctx.relayHome), exists: true };
  const problems: ConfigProblem[] = [];
  const add = (key: string, message: string) => problems.push({ key, message });
  const root: Table = isTable(raw) ? raw : {};

  // Account references may name an account defined later in the file.
  const defined = new Set(
    Object.keys(isTable(root.accounts) ? root.accounts : {}).filter((id) => parseAccountId(id) !== null),
  );

  function walkTable(key: string, value: unknown, handlers: Handlers): boolean {
    if (!isTable(value)) {
      add(key, TABLE);
      return false;
    }
    for (const [name, child] of Object.entries(value)) {
      const childKey = `${key}.${quoteKey(name)}`;
      // Keys come from the file, so names such as __proto__ or constructor must not find an
      // inherited property.
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
      if (handler) handler(childKey, child);
      else unknownKey(childKey, name, child);
    }
    return true;
  }

  function unknownKey(key: string, name: string, value: unknown): void {
    add(key, isCredentialName(name) ? CREDENTIAL : UNKNOWN);
    reportCredentialKeys(key, value);
  }

  // A credential can hide one level down, inside a table relay does not know.
  function reportCredentialKeys(key: string, value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => reportCredentialKeys(`${key}[${index + 1}]`, item));
    } else if (isTable(value)) {
      for (const [name, child] of Object.entries(value)) {
        const childKey = `${key}.${quoteKey(name)}`;
        if (isCredentialName(name)) add(childKey, CREDENTIAL);
        reportCredentialKeys(childKey, child);
      }
    }
  }

  function accountRef(key: string, value: string): AccountId | null {
    if (!ACCOUNT_ID.test(value)) {
      add(key, ACCOUNT_NAME_FORM);
      return null;
    }
    if (!defined.has(value)) {
      add(key, `${quote(value)} is not one of your accounts.`);
      return null;
    }
    return value as AccountId;
  }

  function pathSetting(key: string, value: unknown): string | null {
    if (typeof value !== "string") {
      add(key, STRING);
      return null;
    }
    const path = expandPath(value, ctx.homedir);
    if (path === null) add(key, PATH_FORM);
    return path;
  }

  const profileOwners = new Map<string, string>();
  function claimProfileDir(key: string, dir: string, accountKey: string): void {
    const owner = profileOwners.get(dir);
    if (owner === undefined) profileOwners.set(dir, accountKey);
    else add(key, `the same folder as ${owner}. Each account needs its own profile folder.`);
  }

  function checkAccount(id: string, value: unknown): void {
    const key = `accounts.${quoteKey(id)}`;
    const parsed = parseAccountId(id);
    if (parsed === null) {
      const provider = ACCOUNT_ID.exec(id)?.[1];
      add(
        key,
        provider === undefined
          ? ACCOUNT_NAME_FORM
          : `relay does not support "${provider}" yet. Supported providers: ${PROVIDERS.join(", ")}.`,
      );
    }
    const found: { profileDir: string | null; credentialEnv: string[]; kind: "personal" | "work" | null } = {
      profileDir: null,
      credentialEnv: [],
      kind: null,
    };
    const isTableValue = walkTable(key, value, {
      profile_dir: (childKey, child) => {
        found.profileDir = pathSetting(childKey, child);
        if (found.profileDir !== null && parsed !== null) claimProfileDir(childKey, found.profileDir, key);
      },
      credential_env: (childKey, child) => {
        if (Array.isArray(child) && child.every((name) => typeof name === "string" && VARIABLE_NAME.test(name))) {
          found.credentialEnv = child as string[];
          // One provider's key must never reach another provider's program (add-provider-adapters,
          // design decision 6).
          for (const name of found.credentialEnv) {
            const problem = parsed === null ? null : credentialNameProblem(parsed.provider, name);
            if (problem !== null) add(childKey, `${name} is not allowed: ${problem}.`);
          }
        } else {
          add(childKey, 'must be a list of variable names in capitals, for example "ANTHROPIC_API_KEY".');
        }
      },
      kind: (childKey, child) => {
        if (child === "personal" || child === "work") found.kind = child;
        else add(childKey, 'must be "personal" or "work".');
      },
    });
    if (parsed === null || !isTableValue) return;
    const profileDirIsDefault = !Object.hasOwn(value as Table, "profile_dir");
    if (profileDirIsDefault) {
      found.profileDir = join(ctx.relayHome, "profiles", `${parsed.provider}-${parsed.name}`);
      claimProfileDir(`${key}.profile_dir`, found.profileDir, key);
    }
    const { profileDir, credentialEnv, kind } = found;
    if (profileDir === null) return;
    config.accounts.push({ id: id as AccountId, ...parsed, profileDir, profileDirIsDefault, credentialEnv, kind });
  }

  const projectPaths = new Map<string, number>();
  function checkProject(index: number, value: unknown): void {
    const key = `projects[${index}]`;
    const found: { path: string | null; allow: AccountId[] | null } = { path: null, allow: null };
    const isTableValue = walkTable(key, value, {
      path: (childKey, child) => {
        const path = pathSetting(childKey, child);
        if (path === null) return;
        found.path = path;
        const first = projectPaths.get(path);
        if (first === undefined) projectPaths.set(path, index);
        else add(childKey, `the same path as projects[${first}].`);
      },
      allow: (childKey, child) => {
        if (!Array.isArray(child) || !child.every((name) => typeof name === "string")) {
          add(childKey, "must be a list of account names.");
          return;
        }
        const allow: AccountId[] = [];
        for (const name of child as string[]) {
          const id = accountRef(childKey, name);
          if (id === null) continue;
          if (allow.includes(id)) add(childKey, `${quote(id)} is listed twice.`);
          else allow.push(id);
        }
        found.allow = allow;
      },
    });
    if (!isTableValue) return;
    const table = value as Table;
    if (!Object.hasOwn(table, "path")) add(`${key}.path`, "is required.");
    if (!Object.hasOwn(table, "allow")) add(`${key}.allow`, "is required.");
    if (found.path !== null && found.allow !== null) config.projects.push({ path: found.path, allow: found.allow });
  }

  const t3ProjectPaths = new Map<string, number>();
  const instanceAccounts = new Map<AccountId, string>();
  function checkInstance(id: string, value: unknown): void {
    const key = `t3.instances.${quoteKey(id)}`;
    const validId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
    if (!validId) add(key, 'T3 provider instance IDs use letters, digits, "_" and "-".');
    const found: { account: AccountId | null; model: string | null } = { account: null, model: null };
    const isTableValue = walkTable(key, value, {
      account: (childKey, child) => {
        if (typeof child !== "string") add(childKey, STRING);
        else {
          found.account = accountRef(childKey, child);
          if (found.account === null) return;
          const first = instanceAccounts.get(found.account);
          if (first === undefined) instanceAccounts.set(found.account, key);
          else add(childKey, `the same account as ${first}.`);
        }
      },
      model: (childKey, child) => {
        if (typeof child === "string" && child.trim().length > 0) found.model = child;
        else add(childKey, STRING);
      },
    });
    if (!isTableValue) return;
    if (!Object.hasOwn(value as Table, "account")) add(`${key}.account`, "is required.");
    if (validId && found.account !== null) config.t3.instances.push({ id, account: found.account, model: found.model });
  }

  const limitChecks: { key: string; setting: LimitSetting; hasSwitchTo: boolean }[] = [];
  function checkLimits(id: string, value: unknown): void {
    const key = `limits.${quoteKey(id)}`;
    const account = accountRef(key, id);
    if (!isTable(value)) {
      add(key, TABLE);
      return;
    }
    for (const [name, child] of Object.entries(value)) {
      const windowKey = `${key}.${quoteKey(name)}`;
      if (!(LIMIT_WINDOWS as readonly string[]).includes(name)) {
        add(windowKey, "unknown window. Use five_hour or seven_day.");
        reportCredentialKeys(windowKey, child);
        continue;
      }
      const found: LimitSetting = {
        account: (account ?? id) as AccountId, window: name as LimitWindow,
        threshold: null, action: null, switchTo: null,
      };
      const isTableValue = walkTable(windowKey, child, {
        threshold: (childKey, setting) => {
          if (Number.isInteger(setting) && (setting as number) >= 1 && (setting as number) <= 100) {
            found.threshold = setting as number;
          } else add(childKey, "must be a whole number from 1 to 100.");
        },
        action: (childKey, setting) => {
          if ((LIMIT_ACTIONS as readonly unknown[]).includes(setting)) found.action = setting as LimitAction;
          else add(childKey, 'must be "wait", "switch" or "notify".');
        },
        switch_to: (childKey, setting) => {
          if (typeof setting !== "string") add(childKey, STRING);
          else found.switchTo = accountRef(childKey, setting);
        },
      });
      if (account === null || !isTableValue) continue;
      config.limits.push(found);
      limitChecks.push({ key: windowKey, setting: found, hasSwitchTo: Object.hasOwn(child as Table, "switch_to") });
    }
    // An empty account table still opts this account into the default rules.
    if (account !== null && Object.keys(value).length === 0) {
      for (const window of LIMIT_WINDOWS) {
        config.limits.push({ account, window, threshold: null, action: null, switchTo: null });
      }
    }
  }

  for (const [name, value] of Object.entries(root)) {
    switch (name) {
      case "version":
        if (value === 1) break;
        if (typeof value === "number" && Number.isInteger(value) && value > 1) {
          add("version", `this file is for a newer relay (version ${value}). Update relay.`);
        } else {
          add("version", "must be 1.");
        }
        break;
      case "defaults":
        walkTable("defaults", value, {
          account: (key, child) => {
            if (typeof child !== "string") add(key, STRING);
            else config.defaults.account = accountRef(key, child);
          },
        });
        break;
      case "log":
        walkTable("log", value, {
          level: (key, child) => {
            if ((LOG_LEVELS as readonly unknown[]).includes(child)) config.log.level = child as LogLevel;
            else add(key, "must be debug, info, warn or error.");
          },
        });
        break;
      case "checkpoint":
        walkTable("checkpoint", value, {
          max_file_size_mb: (key, child) => {
            if (Number.isInteger(child) && (child as number) >= 1 && (child as number) <= 1024) {
              config.checkpoint.maxFileSizeMb = child as number;
            } else {
              add(key, "must be a whole number from 1 to 1024.");
            }
          },
        });
        break;
      case "accounts":
        if (isTable(value)) for (const [id, child] of Object.entries(value)) checkAccount(id, child);
        else add("accounts", TABLE);
        break;
      case "projects":
        if (Array.isArray(value)) value.forEach((item, index) => checkProject(index + 1, item));
        else add("projects", "must be a list of [[projects]] tables.");
        break;
      case "t3":
        walkTable("t3", value, {
          url: (key, child) => {
            if (typeof child !== "string") {
              add(key, STRING);
              return;
            }
            let url: URL;
            try {
              url = new URL(child);
            } catch {
              add(key, "must look like http://127.0.0.1:3773/mcp.");
              return;
            }
            if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
              add(key, "relay only connects to T3 Code on this computer (127.0.0.1 or localhost).");
            } else if (url.protocol !== "http:" || url.pathname !== "/mcp") {
              add(key, "must look like http://127.0.0.1:3773/mcp.");
            } else config.t3.url = child;
          },
          projects: (key, child) => {
            if (!Array.isArray(child)) {
              add(key, "must be a list of folders.");
              return;
            }
            child.forEach((item, index) => {
              const childKey = `${key}[${index + 1}]`;
              const path = pathSetting(childKey, item);
              if (path === null) return;
              const first = t3ProjectPaths.get(path);
              if (first === undefined) t3ProjectPaths.set(path, index + 1);
              else add(childKey, `the same path as t3.projects[${first}].`);
              config.t3.projects.push(path);
            });
          },
          instances: (key, child) => {
            if (isTable(child)) for (const [id, instance] of Object.entries(child)) checkInstance(id, instance);
            else add(key, TABLE);
          },
        });
        break;
      case "limits":
        if (isTable(value)) for (const [id, child] of Object.entries(value)) checkLimits(id, child);
        else add("limits", TABLE);
        break;
      case "handoff": {
        const seconds = (field: Exclude<keyof RelayConfig["handoff"], "askForSummary">, low: number, high: number) =>
          (key: string, child: unknown) => {
            if (Number.isInteger(child) && (child as number) >= low && (child as number) <= high) config.handoff[field] = child as number;
            else add(key, `must be a whole number from ${low} to ${high}.`);
          };
        walkTable("handoff", value, {
          ask_for_summary: (key, child) => {
            if (typeof child === "boolean") config.handoff.askForSummary = child;
            else add(key, "must be true or false.");
          },
          summary_timeout_seconds: seconds("summaryTimeoutSeconds", 10, 900),
          stop_timeout_seconds: seconds("stopTimeoutSeconds", 5, 300),
          check_timeout_seconds: seconds("checkTimeoutSeconds", 10, 7200),
          start_check_seconds: seconds("startCheckSeconds", 1, 60),
        });
        break;
      }
      default:
        unknownKey(quoteKey(name), name, value);
    }
  }
  const mapped = new Set(config.t3.instances.map((instance) => instance.account));
  for (const { key, setting, hasSwitchTo } of limitChecks) {
    const targetKey = `${key}.switch_to`;
    if (setting.action === "switch" && !hasSwitchTo) add(targetKey, 'is required when action is "switch".');
    if (setting.switchTo === null) continue;
    const provider = parseAccountId(setting.account)!.provider;
    if (parseAccountId(setting.switchTo)!.provider === provider) {
      add(targetKey, provider === "claude"
        ? "relay does not move work between two Claude accounts on its own. Anthropic's terms say plan limits assume ordinary, individual use."
        : "relay does not move work between two Codex accounts on its own. OpenAI's terms forbid getting around rate limits.");
    } else if (!mapped.has(setting.switchTo)) {
      add(targetKey, `T3 Code has no provider mapped to ${setting.switchTo}. Run relay t3 connect to map it.`);
    }
  }
  return { config, problems };
}

function parseAccountId(id: string): { provider: Provider; name: string } | null {
  const match = ACCOUNT_ID.exec(id);
  if (!match || !(PROVIDERS as readonly string[]).includes(match[1]!)) return null;
  return { provider: match[1] as Provider, name: match[2]! };
}

function isTable(value: unknown): value is Table {
  if (typeof value !== "object" || value === null) return false;
  // TOML dates and times are Temporal objects, not tables.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isCredentialName(name: string): boolean {
  const lower = name.toLowerCase();
  return CREDENTIAL_WORDS.some((word) => lower.includes(word));
}

// Quotes a key that has characters outside [A-Za-z0-9_-], with every non-printing character
// escaped, so that a key cannot change how the terminal shows the message.
function quoteKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : quote(name);
}
