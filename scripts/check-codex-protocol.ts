// Checks that the installed Codex still has every app-server method, field and value that the
// Codex adapter uses, as listed in src/adapters/codex/protocol-used.json (the
// adapter-contract-tests spec, "Codex protocol drift check"). Run it by hand before using relay
// with a new Codex version: bun run scripts/check-codex-protocol.ts
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type Json = Record<string, unknown>;
function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function variants(value: Json, keys: string[]): unknown[] {
  return keys.flatMap((key) => (Array.isArray(value[key]) ? (value[key] as unknown[]) : []));
}
// The schemas of a field: the property of that name in the definition or in one of its variants.
function fieldSchemas(value: unknown, field: string): unknown[] {
  if (!object(value)) return [];
  const own = object(value.properties) && Object.hasOwn(value.properties, field) ? [value.properties[field]] : [];
  return [...own, ...variants(value, ["oneOf", "anyOf", "allOf"]).flatMap((member) => fieldSchemas(member, field))];
}
// The values a schema itself allows: its const and enum, and those of the variants it lists. The
// values of its properties are not included.
function ownValues(value: unknown): unknown[] {
  if (!object(value)) return [];
  const own = [...(Object.hasOwn(value, "const") ? [value.const] : []), ...(Array.isArray(value.enum) ? value.enum : [])];
  return [...own, ...variants(value, ["oneOf", "anyOf"]).flatMap(ownValues)];
}
// A definition without its documentation and nested definitions, with sorted keys, so that two
// copies of one definition in different files compare equal. The combined schema file refers to
// "#/definitions/v2/<name>" where the single files refer to "#/definitions/<name>".
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (!object(value)) return value;
  const ignored = new Set(["$schema", "definitions", "title", "description"]);
  return Object.fromEntries(Object.keys(value).filter((key) => !ignored.has(key)).sort().map((key) => [key,
    key === "$ref" && typeof value[key] === "string" ? (value[key] as string).replace("#/definitions/v2/", "#/definitions/") : shape(value[key])]));
}
function files(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
  });
}
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || args.length === 2 && args[0] === "--schema-dir" && args[1] !== "")) {
    console.error("Usage: bun run scripts/check-codex-protocol.ts [--schema-dir <folder>]");
    return 2;
  }
  const program = process.env.RELAY_CODEX_BIN ?? Bun.which("codex", { PATH: process.env.PATH });
  if (!program) throw new Error("Codex is not installed.");
  const command = program.endsWith(".ts") ? [process.execPath, program] : [program];
  async function run(argv: string[]): Promise<string> {
    const child = Bun.spawn([...command, ...argv], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    try {
      const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`Codex exited with code ${code}.`);
      return out;
    } finally { clearTimeout(timer); }
  }
  const version = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(await run(["--version"]))?.[1];
  if (version === undefined) throw new Error("Codex did not report its version.");
  const temporary = args.length === 0 ? mkdtempSync(join(tmpdir(), "relay-codex-schema-")) : undefined;
  const folder = temporary ?? resolve(args[1]!);
  try {
    if (temporary !== undefined) await run(["app-server", "generate-json-schema", "--out", folder]);
    const schemas = files(folder).map((file) => ({ name: basename(file, ".json"), value: JSON.parse(readFileSync(file, "utf8")) as unknown }));
    const definitions: Json = {};
    const conflicts = new Set<string>();
    const define = (name: string, value: unknown) => {
      if (Object.hasOwn(definitions, name) && JSON.stringify(shape(definitions[name])) !== JSON.stringify(shape(value))) conflicts.add(name);
      else definitions[name] ??= value;
    };
    for (const { name, value } of schemas) {
      if (!object(value)) continue;
      if (object(value.definitions)) for (const [key, definition] of Object.entries(value.definitions)) define(key, definition);
      define(typeof value.title === "string" ? value.title : name, value);
    }
    for (const name of conflicts) console.log(`Codex ${version} defines ${name} more than once, with different shapes, so relay cannot tell which one to check.`);
    if (conflicts.size > 0) return 1;
    const entries = JSON.parse(readFileSync(resolve(import.meta.dir, "../src/adapters/codex/protocol-used.json"), "utf8")) as string[];
    // "Type.field" needs the field; "Type=value" needs the value among the type's own values;
    // "Type.field=value" needs it among the field's values. A method is a value of the field
    // "method" of ClientRequest, ServerRequest or ServerNotification, so its direction is checked too.
    const missing = entries.filter((entry) => {
      const equals = entry.indexOf("=");
      const path = equals === -1 ? entry : entry.slice(0, equals);
      const dot = path.indexOf(".");
      const definition = definitions[dot === -1 ? path : path.slice(0, dot)];
      const targets = dot === -1 ? [definition] : fieldSchemas(definition, path.slice(dot + 1));
      if (equals === -1) return definition === undefined || targets.length === 0;
      return !targets.some((target) => ownValues(target).includes(entry.slice(equals + 1)));
    });
    for (const entry of missing) console.log(`Missing in Codex ${version}: ${entry}`);
    if (missing.length > 0) return 1;
    console.log(`Codex ${version} has every method, field and value relay uses.`);
    return 0;
  } finally { if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
