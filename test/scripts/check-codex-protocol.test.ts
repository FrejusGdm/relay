import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../scripts/check-codex-protocol.ts");
const fake = resolve(import.meta.dir, "../fakes/fake-codex.ts");
const entries = JSON.parse(readFileSync(resolve(import.meta.dir, "../../src/adapters/codex/protocol-used.json"), "utf8")) as string[];
const MESSAGES = ["ClientRequest", "ServerRequest", "ServerNotification"];

type Definition = { properties: Record<string, unknown>; anyOf: unknown[] };

// Builds definitions that hold every entry: "Type.field" as a property, "Type=value" as a variant
// with that enum, and "Type.field=value" as a variant whose field has that enum. `change` may
// rewrite an entry, or drop it by returning null.
function definitionsFor(change: (entry: string) => string | null): Record<string, Definition> {
  const definitions: Record<string, Definition> = {};
  for (const original of entries) {
    const entry = change(original);
    if (entry === null) continue;
    const equal = entry.indexOf("=");
    const path = equal === -1 ? entry : entry.slice(0, equal);
    const dot = path.indexOf(".");
    const definition = definitions[dot === -1 ? path : path.slice(0, dot)] ??= { properties: {}, anyOf: [] };
    const field = path.slice(dot + 1);
    if (equal === -1) definition.properties[field] = { type: "string" };
    else if (dot === -1) definition.anyOf.push({ enum: [entry.slice(equal + 1)] });
    else definition.anyOf.push({ properties: { [field]: { enum: [entry.slice(equal + 1)] } } });
  }
  return definitions;
}

// Writes the message definitions as top-level files, as Codex does, the others into a nested file
// and `extra` into a third file, runs the script on the folder and returns its exit code and output.
async function check(definitions: Record<string, Definition>, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-protocol-test-"));
  try {
    const schema = join(root, "schema");
    mkdirSync(join(schema, "nested"), { recursive: true });
    const nested = Object.fromEntries(Object.entries(definitions).filter(([name]) => !MESSAGES.includes(name)));
    writeFileSync(join(schema, "nested/types.json"), JSON.stringify({ definitions: nested }));
    for (const name of MESSAGES) writeFileSync(join(schema, `${name}.json`), JSON.stringify({ title: name, ...definitions[name] }));
    writeFileSync(join(schema, "extra.json"), JSON.stringify({ definitions: extra }));
    const child = Bun.spawn([process.execPath, script, "--schema-dir", schema], {
      env: { ...process.env, RELAY_CODEX_BIN: fake, RELAY_FAKE_SCENARIO: "", RELAY_FAKE_RECORD: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      return { code, stdout };
    } finally { clearTimeout(timer); child.kill("SIGKILL"); await child.exited; }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("Protocol check accepts the complete schema, with a second copy that differs only in its documentation", async () => {
  const definitions = definitionsFor((entry) => entry);
  const copy = { ...definitions.Thread, title: "Thread", description: "The same definition, written again." };
  expect(await check(definitions, { Thread: copy })).toEqual({ code: 0, stdout: "Codex 0.160.0 has every method, field and value relay uses.\n" });
}, 10_000);

test("Protocol check reports the missing developerInstructions field", async () => {
  const definitions = definitionsFor((entry) => (entry === "ThreadStartParams.developerInstructions" ? null : entry));
  expect(await check(definitions)).toEqual({ code: 1, stdout: "Missing in Codex 0.160.0: ThreadStartParams.developerInstructions\n" });
}, 10_000);

test("Protocol check reports a method that exists only in the other direction", async () => {
  const definitions = definitionsFor((entry) =>
    entry === "ServerNotification.method=turn/started" ? "ClientRequest.method=turn/started" : entry);
  expect(await check(definitions)).toEqual({ code: 1, stdout: "Missing in Codex 0.160.0: ServerNotification.method=turn/started\n" });
}, 10_000);

test("Protocol check matches a value only on its own type or field", async () => {
  // "completed" only as a value of a field of TurnStatus, and "text" as a value of UserInput
  // itself instead of its field "type".
  const definitions = definitionsFor((entry) => {
    if (entry === "TurnStatus=completed") return "TurnStatus.other=completed";
    if (entry === "UserInput.type=text") return "UserInput=text";
    return entry;
  });
  expect(await check(definitions)).toEqual({
    code: 1,
    stdout: "Missing in Codex 0.160.0: TurnStatus=completed\nMissing in Codex 0.160.0: UserInput.type=text\n",
  });
}, 10_000);

test("Protocol check fails when one definition appears twice with different shapes", async () => {
  const definitions = definitionsFor((entry) => entry);
  expect(await check(definitions, { Thread: { properties: { id: { type: "integer" } } } })).toEqual({
    code: 1,
    stdout: "Codex 0.160.0 defines Thread more than once, with different shapes, so relay cannot tell which one to check.\n",
  });
}, 10_000);
