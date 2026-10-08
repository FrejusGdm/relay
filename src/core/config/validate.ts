import { join } from "node:path";
import { PROVIDERS, type Provider } from "../../adapters/providers";
import { expandPath } from "../paths";
import { quote } from "../quote";
import { LOG_LEVELS, type AccountId, type ConfigProblem, type LogLevel, type RelayConfig } from "./types";

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

  // Allow lists and defaults.account may name an account defined later in the file.
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
      default:
        unknownKey(quoteKey(name), name, value);
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
