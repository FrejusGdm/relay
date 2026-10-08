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
function contains(value: unknown, check: (value: Json) => boolean): boolean {
  if (Array.isArray(value)) return value.some((item) => contains(item, check));
  return object(value) && (check(value) || Object.values(value).some((item) => contains(item, check)));
}
function hasField(value: unknown, field: string): boolean {
  if (!object(value)) return false;
  if (object(value.properties) && field in value.properties) return true;
  return [value.oneOf, value.anyOf, value.allOf].some((members) => Array.isArray(members) && members.some((member) => hasField(member, field)));
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
    for (const { name, value } of schemas) {
      if (object(value)) {
        if (object(value.definitions)) Object.assign(definitions, value.definitions);
        definitions[typeof value.title === "string" ? value.title : name] = value;
      }
    }
    const entries = JSON.parse(readFileSync(resolve(import.meta.dir, "../src/adapters/codex/protocol-used.json"), "utf8")) as string[];
    const missing = entries.filter((entry) => {
      if (entry.startsWith("method:")) {
        const method = entry.slice(7);
        return !schemas.some(({ value }) => contains(value, (node) => object(node.method) && (node.method.const === method || Array.isArray(node.method.enum) && node.method.enum.includes(method))));
      }
      const equals = entry.indexOf("=");
      if (equals !== -1) {
        const value = entry.slice(equals + 1);
        return !contains(definitions[entry.slice(0, equals)], (node) => node.const === value || Array.isArray(node.enum) && node.enum.includes(value));
      }
      const dot = entry.indexOf(".");
      return !hasField(definitions[entry.slice(0, dot)], entry.slice(dot + 1));
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
