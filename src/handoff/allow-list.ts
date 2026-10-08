// The accounts that may receive a job (add-relay-switch, design decision 16; docs/research/
// security.md section 6). The allow list is the `allow` list of the project's [[projects]] entry in
// config.toml, outside the repository, so nothing in the repository can grant an account. The first
// handoff to an account that is not on it asks the person, naming the company that receives the code.
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { CommandError } from "../cli/errors";
import { ExitCode } from "../cli/exit-codes";
import { appendTable, editConfig, type ConfigContext } from "../core/config/edit";
import type { Account, Project, RelayConfig } from "../core/config/types";
import { expandPath } from "../core/paths";
import type { Repository } from "../git/repo";
import { parseToml } from "../platform/toml";
import { policyOf } from "../policies/load";
import { accountLabel } from "./account";
import { isYes, type AnswerHow, type Asker } from "./ask";

interface AllowRequest {
  asker: Asker;
  config: RelayConfig;
  configContext: ConfigContext;
  repo: Repository;
  // The account of the job's current or last worker, or null when no agent has worked on the job.
  from: Account | null;
  // Whether that worker's agent is still running, for the message after a "no".
  fromRunning: boolean;
  to: Account;
  // "switch" or "run", for the hint line.
  command: string;
}

interface AllowResult {
  // The account added to the allow list, for the provider_allowed event.
  allowed: { account: string; company: string; how: AnswerHow } | null;
  confirmations: { question: string; how: AnswerHow }[];
}

// The project's entry: the one whose path is the worktree root, or else the main worktree root of
// the same repository (the folder that holds the common .git folder).
export function projectEntry(config: RelayConfig, repo: Repository): Project | null {
  const roots = [repo.worktreeRoot, ...(basename(repo.commonDir) === ".git" ? [dirname(repo.commonDir)] : [])];
  for (const root of roots) {
    const entry = config.projects.find((project) => project.path === root || realPath(project.path) === root);
    if (entry !== undefined) return entry;
  }
  return null;
}

export async function checkAllowList(request: AllowRequest): Promise<AllowResult> {
  const { asker, to } = request;
  const result: AllowResult = { allowed: null, confirmations: [] };
  const entry = projectEntry(request.config, request.repo);
  const company = policyOf(to.provider).company;
  const nothingChanged = request.from !== null && request.fromRunning
    ? `Nothing changed. ${accountLabel(request.from)} is still working.`
    : "Nothing changed.";
  const hint = `Run "relay ${request.command} ${to.id}" in a terminal, or add --yes.`;

  if (!entry?.allow.includes(to.id)) {
    const question = `This sends the repository and the job notes to ${company} through the account ${to.id}. Continue? [y/N]`;
    const how = await answer(asker, question, [`${to.id} has not worked on this project before. Sending the repository to ${company} needs your yes.`, hint], nothingChanged,
      request.from?.provider === to.provider ? [policyOf(to.provider).ownAccountsNote] : []);
    result.allowed = { account: to.id, company, how };
    result.confirmations.push({ question, how });
  }

  if (request.from?.kind === "work" && to.kind === "personal") {
    const warning = `This job ran on a work account (${request.from.id}). ${to.id} is marked personal.`;
    const how = await answer(asker, "Continue? [y/N]", [warning, hint], nothingChanged, [warning]);
    result.confirmations.push({ question: warning, how });
  }
  // Written only once every question has its yes, so a "no" leaves config.toml as it was.
  if (result.allowed !== null) addToAllowList(request, entry);
  return result;
}

async function answer(asker: Asker, question: string, needsYes: string[], refusal: string, before: string[]): Promise<AnswerHow> {
  if (asker.yes) return "flag";
  if (!asker.terminal) throw new CommandError(ExitCode.NeedsPerson, needsYes);
  for (const line of before) asker.say(line);
  if (isYes(await asker.ask(question))) return "terminal";
  throw new CommandError(ExitCode.NeedsPerson, [refusal]);
}

// Adds the account to the entry's allow list through the one writer of config.toml, which keeps every
// other line as it was. A project without an entry gets one, with the outgoing account too.
function addToAllowList(request: AllowRequest, entry: Project | null): void {
  const { to, configContext } = request;
  editConfig(
    configContext,
    (text) => {
      if (entry === null) {
        const accounts = [...(request.from === null ? [] : [request.from.id]), to.id].map((id) => JSON.stringify(id));
        return appendTable(text, `[[projects]]\npath = ${JSON.stringify(request.repo.worktreeRoot)}\nallow = [${accounts.join(", ")}]\n`);
      }
      return insertIntoAllow(text, entry.path, to.id, configContext.homedir);
    },
    (config) => projectEntry(config, request.repo)?.allow.includes(to.id) === true,
  );
}

// Finds the [[projects]] table whose path is `path` and adds `id` at the end of its allow array.
function insertIntoAllow(text: string, path: string, id: string, homedir: string): string {
  const headers = [...text.matchAll(/^[ \t]*\[\[[ \t]*projects[ \t]*\]\][ \t]*(?:#.*)?$/gm)].map((match) => match.index!);
  for (const start of headers) {
    const rest = text.slice(start);
    const next = /\n[ \t]*\[/.exec(rest.slice(1));
    const block = next === null ? rest : rest.slice(0, next.index + 1);
    let table: Record<string, unknown>;
    try {
      table = parseToml(block.replace(/^[^\n]*/, "")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof table.path !== "string" || expandPath(table.path, homedir) !== path) continue;
    const allow = /^[ \t]*allow[ \t]*=[ \t]*\[/m.exec(block);
    if (allow === null) break;
    return insertIntoArray(text, start + allow.index + allow[0].length - 1, JSON.stringify(id));
  }
  throw new CommandError(ExitCode.Failed, [
    `relay could not find the allow list of this project in config.toml. Add "${id}" to it yourself.`,
  ]);
}

// Inserts `value` as the last item of the array whose "[" is at `open`, after its last item, so that
// the comments and the layout of the array stay as they were.
function insertIntoArray(text: string, open: number, value: string): string {
  let last = open;
  let depth = 1;
  let i = open + 1;
  while (i < text.length && depth > 0) {
    const char = text[i]!;
    if (char === "#") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (char === '"' || char === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== char) j += char === '"' && text[j] === "\\" ? 2 : 1;
      last = j;
      i = j + 1;
      continue;
    }
    if (char === "[") depth++;
    else if (char === "]") depth--;
    if (depth > 0 && !/\s/.test(char)) last = i;
    i++;
  }
  const insertion = last === open ? value : text[last] === "," ? ` ${value}` : `, ${value}`;
  return `${text.slice(0, last + 1)}${insertion}${text.slice(last + 1)}`;
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
