// Records a real fixture for the contract suite (add-provider-adapters, design decision 18;
// the adapter-contract-tests spec, "Recording real fixtures is opt-in"). It runs the real
// program only when RELAY_RECORD=1 is set, never in bun test or CI, and writes nothing when the
// secret scan finds anything in the redacted output.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanTexts } from "../src/secrets/scan";
import { now, setClock } from "../src/platform/clock";
import { CONTRACT_ENTRIES } from "../test/adapters/registry";
import { FIXTURES_ROOT } from "../test/adapters/fixtures";
import type { Transport, WorkerEvent } from "../src/adapters/types";

const PROMPT = "Create the file hello.txt containing the word hi, then stop.";
type Json = Record<string, unknown>;
function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const [provider, folder, name] = args;
  const transports: Record<string, Transport> = { "claude/print": "claude-print", "codex/exec": "codex-exec", "codex/app-server": "codex-app-server" };
  const transport = transports[`${provider}/${folder}`];
  if (transport === undefined || name === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !(args.length === 3 || args.length === 5 && args[3] === "--fixtures-root" && args[4] !== "")) {
    console.error("Usage: bun run scripts/record-fixture.ts <provider> <transport-folder> <name> [--fixtures-root <folder>]");
    return 2;
  }
  const programName = provider === "claude" ? "claude" : "codex";
  if (process.env.RELAY_RECORD !== "1") {
    console.error(`Recording runs the real ${programName} program and uses your plan. Set RELAY_RECORD=1 to continue.`);
    return 2;
  }
  console.log(`This recording runs ${programName} and uses your plan.`);
  const program = process.env[provider === "claude" ? "RELAY_CLAUDE_BIN" : "RELAY_CODEX_BIN"] ?? Bun.which(programName, { PATH: process.env.PATH });
  if (!program) throw new Error(`${programName} is not installed.`);
  const command = program.endsWith(".ts") ? [process.execPath, program] : [program];
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "relay-record-")));
  const recordedAt = now().toISOString();
  try {
    writeFileSync(join(repo, "README.md"), "# Fixture recording\n");
    const git = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "init", "--quiet", repo], { env: { ...process.env, RELAY_GIT_RUNNER: "1" }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    await new Response(git.stderr).text();
    if (await git.exited !== 0) throw new Error("Could not create the temporary repository.");
    const versionChild = Bun.spawn([...command, "--version"], { cwd: repo, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const versionTimer = setTimeout(() => versionChild.kill("SIGKILL"), 30_000);
    let toolVersion: string | undefined;
    try {
      const [out, , code] = await Promise.all([new Response(versionChild.stdout).text(), new Response(versionChild.stderr).text(), versionChild.exited]);
      toolVersion = /\b\d+\.\d+\.\d+\b/.exec(out)?.[0];
      if (code !== 0 || toolVersion === undefined) throw new Error("The program did not report its version.");
    } finally { clearTimeout(versionTimer); }
    const argv = transport === "claude-print" ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : transport === "codex-exec" ? ["exec", "--json", "-C", repo, "-s", "workspace-write", PROMPT] : ["app-server"];
    const child = Bun.spawn([...command, ...argv], { cwd: repo, env: process.env, stdin: transport === "codex-exec" ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    const lines: unknown[] = [];
    let timedOut = false;
    let finished = false;
    let threadId: string | undefined;
    let nextId = 1;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      void reader.cancel().catch(() => {});
    }, 600_000);
    const stderr = new Response(child.stderr).text();
    function send(message: Json): void {
      if (transport === "codex-app-server") lines.push({ dir: "client", msg: message });
      if (typeof child.stdin === "object" && child.stdin !== null) {
        child.stdin.write(JSON.stringify(message) + "\n");
        child.stdin.flush();
      }
    }
    function close(): void {
      finished = true;
      if (typeof child.stdin === "object" && child.stdin !== null) child.stdin.end();
    }
    function request(method: string, params?: Json): void {
      send({ id: nextId++, method, ...(params === undefined ? {} : { params }) });
    }
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    function line(text: string): void {
      if (text === "") return;
      const message: unknown = JSON.parse(text);
      lines.push(transport === "codex-app-server" ? { dir: "server", msg: message } : message);
      if (!object(message)) return;
      if (transport === "claude-print" && message.type === "result") close();
      if (transport !== "codex-app-server") return;
      if (object(message.error) && message.id !== undefined) throw new Error("The app server refused a recording request.");
      if (message.id === 1 && object(message.result)) {
        send({ method: "initialized" });
        if (name === "rate-limits-read") request("account/rateLimits/read");
        else request("thread/start", { cwd: repo, sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: "<instructions>" });
      } else if (object(message.result) && object(message.result.thread) && typeof message.result.thread.id === "string") {
        threadId = message.result.thread.id;
        request("turn/start", { threadId, input: [{ type: "text", text: PROMPT, text_elements: [] }] });
      } else if (object(message.result) && "rateLimits" in message.result) close();
      else if (message.method === "turn/completed") {
        const turn = object(message.params) && object(message.params.turn) ? message.params.turn : undefined;
        if (turn?.status === "failed" && object(turn.error) && turn.error.codexErrorInfo === "usageLimitExceeded") request("account/rateLimits/read");
        else close();
      }
    }
    try {
      if (transport === "claude-print") send({ type: "user", message: { role: "user", content: PROMPT }, parent_tool_use_id: null });
      if (transport === "codex-app-server") request("initialize", { clientInfo: { name: "relay", title: "relay", version: "0.1.0" }, capabilities: { experimentalApi: false, requestAttestation: false } });
      while (true) {
        const chunk = await reader.read();
        pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) !== -1) { line(pending.slice(0, end).replace(/\r$/, "")); pending = pending.slice(end + 1); }
        if (chunk.done) break;
      }
      if (pending !== "") line(pending);
      if (timedOut) throw new Error("The recording did not finish within ten minutes.");
      const code = await child.exited;
      await stderr;
      if ((transport !== "codex-exec" && !finished) || lines.length === 0 || code === 97) throw new Error("The program stopped before a recording was captured.");
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
      child.kill("SIGKILL");
      await child.exited;
    }
    const redactions: string[] = [];
    function replace(text: string, target: string | undefined, replacement: string, label: string): string {
      if (!target) return text;
      return text.split(target).map((part, i) => { if (i > 0) redactions.push(label); return part; }).join(replacement);
    }
    function redact(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(redact);
      if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (["accountId", "email", "organization_id", "account_uuid"].includes(key)) { redactions.push(`field ${key}`); return [key, "redacted"]; }
        return [key, redact(item)];
      }));
      if (typeof value !== "string") return value;
      let text = replace(value, repo, "/home/user/project", "temporary repository");
      text = replace(text, process.env.HOME, "/home/user", "home folder");
      return text.replace(/[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi, () => { redactions.push("email address"); return "redacted"; });
    }
    const redacted = lines.map(redact);
    const output = redacted.map((message) => JSON.stringify(message)).join("\n") + "\n";
    const findings = await scanTexts([{ label: "output.jsonl", text: output }]);
    const finding = findings[0];
    if (finding !== undefined) {
      console.error(`The recording contains what looks like a secret (${finding.rule} on line ${finding.line}). Nothing was written.`);
      return 1;
    }
    const factory = CONTRACT_ENTRIES.find((entry) => entry.provider === provider)?.transports.find((entry) => entry.id === transport)?.mapper;
    let events: WorkerEvent[] = [];
    if (factory === undefined) console.log(`No event mapper exists yet for ${provider}/${folder}; expected-events.json is empty. Fill it before committing the fixture.`);
    else {
      setClock(() => new Date(recordedAt));
      try {
        const mapper = factory({ interruptSent: name === "interrupted" });
        events = redacted.flatMap((message) => {
          if (transport !== "codex-app-server") return mapper.push(message);
          return object(message) && message.dir === "server" ? mapper.push(message.msg) : [];
        });
        events.push(...mapper.end());
      } finally { setClock(null); }
    }
    const destination = join(args[4] === undefined ? FIXTURES_ROOT : resolve(args[4]), provider!, folder!, name);
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "output.jsonl"), output);
    writeFileSync(join(destination, "expected-events.json"), JSON.stringify(events, null, 2) + "\n");
    writeFileSync(join(destination, "meta.json"), JSON.stringify({ provider, transport, tool_version: toolVersion, recorded_at: recordedAt, source: "recorded", command: argv.map((arg) => arg === PROMPT ? "<prompt>" : arg === repo ? "/home/user/project" : arg), redactions }, null, 2) + "\n");
    console.log(JSON.stringify(events, null, 2));
    console.log("Review the output and events before committing the fixture, and add the tool version to tested-versions.json.");
    return 0;
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`The recording failed: ${(error as Error).message}`); process.exitCode = 1; }
}
