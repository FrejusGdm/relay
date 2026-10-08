// Task 8.1: relay hook delivers to the daemon (design.md decision 18, step 5), run as its own
// process: always silent and exit 0, under 500 ms whatever the daemon and standard input do, the
// spool when the daemon does not accept the event, and only the allowed fields in either place.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spoolLine } from "../../src/hooks/fields";
import { spoolPath } from "../../src/hooks/spool";
import { MAIN } from "../helpers/cli";
import { removeTempRelayHomes, tempRelayHome, testSocket } from "../helpers/relay-home";

afterAll(removeTempRelayHomes);

const FIXTURES = join(import.meta.dir, "..", "fixtures", "hooks");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const DROPPED = ["tool_input", "tool_response", "transcript_path", "error_details", "last_assistant_message", "cat .env.local", "PORT=3000"];
const RELAY_ENV = { RELAY_JOB: "3f9a2c1d", RELAY_TARGET: "claude:work", RELAY_WORKER: "a41c7b09" };

interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

// Runs `relay hook` as its own process. With stdin null, standard input is a pipe that is never
// closed. The time counts from just before the process is started.
async function hook(relayHome: string, args: string[], stdin: string | null, env: Record<string, string> = {}): Promise<HookRun> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, "--no-env-file", MAIN, "hook", ...args], {
    env: { ...process.env, RELAY_HOME: relayHome, ...env },
    stdin: stdin === null ? "pipe" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const ms = performance.now() - started;
  if (stdin === null) {
    try {
      (child.stdin as { end(): void }).end();
    } catch {
      // The process has ended, so the pipe may already be closed.
    }
  }
  return { code, stdout, stderr, ms };
}

// A daemon stand-in on the test socket: "accept" answers every request with 202 and keeps the
// requests; "hang" accepts connections and never answers.
function fakeDaemon(relayHome: string, mode: "accept" | "hang") {
  mkdirSync(join(relayHome, "run"), { mode: 0o700 });
  const requests: { path: string; body: string }[] = [];
  if (mode === "accept") {
    const server = Bun.serve({
      unix: testSocket(relayHome),
      fetch: async (request) => {
        requests.push({ path: new URL(request.url).pathname, body: await request.text() });
        return Response.json({ accepted: true }, { status: 202 });
      },
    });
    return { requests, stop: () => server.stop(true) };
  }
  const listener = Bun.listen({ unix: testSocket(relayHome), socket: { data() {}, open() {} } });
  return { requests, stop: () => listener.stop(true) };
}

const spoolText = (relayHome: string) => readFileSync(spoolPath(relayHome), "utf8");

test("every case exits 0 with empty standard output and standard error", async () => {
  const cases: [string, string[], string, "accept" | null][] = [
    ["unknown provider", ["cursor", "Stop"], "{}", null],
    ["bad event name", ["claude", "Stop;rm"], "{}", null],
    ["invalid JSON", ["claude", "Stop"], "not json", null],
    ["daemon down", ["claude", "StopFailure"], fixture("claude-stop-failure-rate-limit.json"), null],
    ["daemon up", ["claude", "StopFailure"], fixture("claude-stop-failure-rate-limit.json"), "accept"],
  ];
  for (const [name, args, stdin, daemon] of cases) {
    const relayHome = tempRelayHome();
    const fake = daemon === null ? null : fakeDaemon(relayHome, daemon);
    const result = await hook(relayHome, args, stdin, RELAY_ENV);
    fake?.stop();
    expect({ name, code: result.code, stdout: result.stdout, stderr: result.stderr }).toEqual({ name, code: 0, stdout: "", stderr: "" });
  }
}, 30_000);

test("with no daemon the event lands in spool/hooks.jsonl with mode 0600, in a 0700 folder", async () => {
  const relayHome = tempRelayHome();
  const result = await hook(relayHome, ["claude", "StopFailure"], fixture("claude-stop-failure-rate-limit.json"), RELAY_ENV);
  expect(result.code).toBe(0);
  expect(statSync(spoolPath(relayHome)).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(spoolPath(relayHome))).mode & 0o777).toBe(0o700);
  const lines = spoolText(relayHome).trimEnd().split("\n").map((line) => JSON.parse(line));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ provider: "claude", event: "StopFailure", relay_target: "claude:work", fields: { error: "rate_limit" } });
  expect(readFileSync(join(relayHome, "logs", "hook.log"), "utf8")).toContain('"outcome":"recorded"');
}, 30_000);

test("a socket that accepts and never answers: exit 0 within 500 ms, and the event is spooled", async () => {
  const relayHome = tempRelayHome();
  const fake = fakeDaemon(relayHome, "hang");
  const result = await hook(relayHome, ["claude", "Stop"], fixture("claude-stop.json"), RELAY_ENV);
  fake.stop();
  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(result.ms).toBeLessThan(500);
  expect(JSON.parse(spoolText(relayHome))).toMatchObject({ provider: "claude", event: "Stop" });
}, 30_000);

test("standard input left open: exit 0 within 500 ms", async () => {
  const relayHome = tempRelayHome();
  const result = await hook(relayHome, ["claude", "Stop"], null, RELAY_ENV);
  expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(result.ms).toBeLessThan(500);
}, 30_000);

test("the request body is the spool line phase 3 writes, and nothing is spooled when the daemon accepts", async () => {
  const relayHome = tempRelayHome();
  const fake = fakeDaemon(relayHome, "accept");
  const input = fixture("claude-stop-failure-rate-limit.json");
  const env = { ...RELAY_ENV, CLAUDE_CONFIG_DIR: "/srv/profiles/claude-work" };
  const result = await hook(relayHome, ["claude", "StopFailure"], input, env);
  fake.stop();
  expect(result.code).toBe(0);
  expect(fake.requests.map((request) => request.path)).toEqual(["/v1/hooks/claude/StopFailure"]);
  const body = fake.requests[0]!.body;
  const sent = JSON.parse(body);
  expect(body).toBe(JSON.stringify(spoolLine("claude", "StopFailure", JSON.parse(input), env, new Date(sent.received_at))));
  expect(existsSync(spoolPath(relayHome))).toBe(false);
  expect(readFileSync(join(relayHome, "logs", "hook.log"), "utf8")).toContain('"outcome":"sent to the daemon"');

  // The same event with no daemon gives the same line, apart from the time it arrived.
  const offline = tempRelayHome();
  await hook(offline, ["claude", "StopFailure"], input, env);
  expect({ ...JSON.parse(spoolText(offline)), received_at: null }).toEqual({ ...sent, received_at: null });
}, 30_000);

test("tool_input, tool_response, transcript_path and error_details reach neither the request body nor the spool", async () => {
  const daemonHome = tempRelayHome();
  const fake = fakeDaemon(daemonHome, "accept");
  const spoolHome = tempRelayHome();
  for (const name of ["claude-post-tool-use.json", "claude-stop-failure-rate-limit.json", "claude-stop.json"]) {
    const event = JSON.parse(fixture(name)).hook_event_name as string;
    await hook(daemonHome, ["claude", event], fixture(name), RELAY_ENV);
    await hook(spoolHome, ["claude", event], fixture(name), RELAY_ENV);
  }
  fake.stop();
  const written = [...fake.requests.map((request) => request.body), spoolText(spoolHome)].join("\n");
  expect(fake.requests).toHaveLength(3);
  for (const dropped of DROPPED) expect(written).not.toContain(dropped);
}, 30_000);

// The router loads each command's module when the command runs, so relay hook never loads the
// database or git code. src/git/run.ts is the exception: main.ts loads it to stop git processes on
// an interrupt, and loading it starts nothing.
test("relay hook loads neither SQLite nor the git, state or daemon modules", () => {
  const src = resolve(import.meta.dir, "..", "..", "src");
  const loaded = new Set<string>();
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const visit = (file: string) => {
    if (loaded.has(file)) return;
    loaded.add(file);
    // main.ts starts with a #! line, which the transpiler does not accept.
    for (const entry of transpiler.scanImports(readFileSync(file, "utf8").replace(/^#!.*/, ""))) {
      if (entry.kind !== "import-statement") continue;
      const target = entry.path.startsWith(".") ? resolve(dirname(file), entry.path) : entry.path;
      if (target.startsWith("/") && !target.endsWith(".json")) visit(`${target}.ts`);
      else loaded.add(target);
    }
  };
  visit(join(src, "cli", "main.ts"));
  visit(join(src, "cli", "commands", "hook.ts"));
  const relative = [...loaded].map((path) => (path.startsWith(src) ? path.slice(src.length + 1) : path));
  expect(relative).toContain("hooks/hook-command.ts");
  expect(relative).toContain("client/api-client.ts");
  const heavy = relative.filter(
    (path) => path === "bun:sqlite" || path === "bun:ffi" || /^(state|daemon\/(?!paths)|api|checkpoint)\//.test(path) || (path.startsWith("git/") && path !== "git/run.ts"),
  );
  expect(heavy).toEqual([]);
});
