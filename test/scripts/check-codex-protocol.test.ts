import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../scripts/check-codex-protocol.ts");
const fake = resolve(import.meta.dir, "../fakes/fake-codex.ts");
const entries = JSON.parse(readFileSync(resolve(import.meta.dir, "../../src/adapters/codex/protocol-used.json"), "utf8")) as string[];
for (const includeField of [false, true]) test(`Protocol check ${includeField ? "accepts the complete schema" : "reports the missing developerInstructions field"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-protocol-test-"));
  try {
    const definitions: Record<string, { properties: Record<string, unknown>; anyOf: unknown[] }> = {};
    const methods: unknown[] = [];
    for (const entry of entries) {
      if (!includeField && entry === "ThreadStartParams.developerInstructions") continue;
      if (entry.startsWith("method:")) { methods.push({ properties: { method: { const: entry.slice(7) } } }); continue; }
      const equal = entry.indexOf("=");
      const split = equal === -1 ? entry.indexOf(".") : equal;
      const name = entry.slice(0, split);
      const definition = definitions[name] ??= { properties: {}, anyOf: [] };
      if (equal === -1) definition.properties[entry.slice(split + 1)] = { type: "string" };
      else definition.anyOf.push({ enum: [entry.slice(split + 1)] });
    }
    const schema = join(root, "schema");
    mkdirSync(join(schema, "nested"), { recursive: true });
    writeFileSync(join(schema, "nested/types.json"), JSON.stringify({ definitions }));
    writeFileSync(join(schema, "methods.json"), JSON.stringify({ oneOf: methods }));
    const child = Bun.spawn([process.execPath, script, "--schema-dir", schema], {
      env: { ...process.env, RELAY_CODEX_BIN: fake, RELAY_FAKE_SCENARIO: "", RELAY_FAKE_RECORD: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      expect(code).toBe(includeField ? 0 : 1);
      expect(stdout).toBe(includeField ? "Codex 0.160.0 has every method, field and value relay uses.\n" : "Missing in Codex 0.160.0: ThreadStartParams.developerInstructions\n");
    } finally { clearTimeout(timer); child.kill("SIGKILL"); await child.exited; }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);
