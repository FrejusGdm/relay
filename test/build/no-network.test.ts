import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "typescript/unstable/async";
import { type Node, type SourceFile, SyntaxKind } from "typescript/unstable/ast";
import {
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
} from "typescript/unstable/ast/is";

const GLOBALS = new Set(["fetch", "XMLHttpRequest", "EventSource", "WebSocket"]);
const BUN_MEMBERS = new Set(["connect", "listen", "serve", "udpSocket"]);
const NETWORK_MODULE = /^(?:node:)?(?:net|http|https|http2|dgram|tls)$/;
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function stringValue(node: Node | undefined): string | undefined {
  return node && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function nameText(node: Node): string | undefined {
  return isIdentifier(node) ? node.text : stringValue(node);
}

function memberName(node: Node): string | undefined {
  if (isPropertyAccessExpression(node)) return nameText(node.name);
  if (isElementAccessExpression(node)) return stringValue(node.argumentExpression);
  return undefined;
}

function isBun(node: Node): boolean {
  return (isIdentifier(node) && node.text === "Bun") || memberName(node) === "Bun";
}

function moduleSpecifier(node: Node): string | undefined {
  if (isImportDeclaration(node) || isExportDeclaration(node)) return stringValue(node.moduleSpecifier);
  if (isExternalModuleReference(node)) return stringValue(node.expression);
  if (isCallExpression(node)) {
    const callee = node.expression;
    if (callee.kind === SyntaxKind.ImportKeyword || (isIdentifier(callee) && callee.text === "require")) {
      return stringValue(node.arguments[0]);
    }
  }
  return undefined;
}

// The forbidden name that this node uses itself, not through its children.
function networkUse(node: Node): string | undefined {
  if (isIdentifier(node)) return GLOBALS.has(node.text) ? node.text : undefined;
  const member = memberName(node);
  if (member !== undefined && (isPropertyAccessExpression(node) || isElementAccessExpression(node))) {
    if (BUN_MEMBERS.has(member) && isBun(node.expression)) return `Bun.${member}`;
    if (isElementAccessExpression(node) && GLOBALS.has(member)) return member;
  }
  const specifier = moduleSpecifier(node);
  return specifier !== undefined && NETWORK_MODULE.test(specifier) ? JSON.stringify(specifier) : undefined;
}

// A fetch or Bun.connect call with an object literal argument that has a `unix` property.
function isUnixSocketCall(node: Node): boolean {
  if (!isCallExpression(node)) return false;
  const use = networkUse(node.expression);
  if (use !== "fetch" && use !== "Bun.connect") return false;
  return node.arguments.some(
    (argument) =>
      isObjectLiteralExpression(argument) &&
      argument.properties.some(
        (property) =>
          (isPropertyAssignment(property) || isShorthandPropertyAssignment(property)) &&
          nameText(property.name) === "unix",
      ),
  );
}

function scan(source: SourceFile, file: string, found: string[]): void {
  const inClient = file.startsWith("src/client/");
  const allowed = new Set<string>();
  const key = (node: Node) => `${node.kind}:${node.pos}:${node.end}`;
  const visit = (node: Node): undefined => {
    if (inClient && isUnixSocketCall(node) && isCallExpression(node)) allowed.add(key(node.expression));
    const use = networkUse(node);
    if (use !== undefined && !allowed.has(key(node))) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push(`${file}:${line}: ${use}`);
    }
    node.forEachChild(visit);
    return undefined;
  };
  source.forEachChild(visit);
}

// Parses every code file under <root>/src with the TypeScript compiler and lists each network use
// that the build-and-ci spec forbids, as "file:line: name". <root> must have a tsconfig.json.
async function forbiddenNetworkUse(root: string): Promise<string[]> {
  const api = new API({ cwd: root });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [join(root, "tsconfig.json")] });
    const program = snapshot.getProjects()[0]!.program;
    const found: string[] = [];
    for (const name of readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })) {
      const path = join(root, "src", name);
      if (!CODE_FILE.test(name) || !statSync(path).isFile()) continue;
      const source = await program.getSourceFile(path);
      if (source === undefined) found.push(`src/${name}: not parsed`);
      else scan(source, `src/${name}`, found);
    }
    return found.sort();
  } finally {
    await api.close();
  }
}

async function withScratchSource(files: Record<string, string[]>, check: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "relay-no-network-"));
  try {
    writeFileSync(join(root, "tsconfig.json"), '{ "compilerOptions": { "allowJs": true, "noEmit": true } }\n');
    for (const [name, lines] of Object.entries(files)) {
      mkdirSync(join(root, "src", name, ".."), { recursive: true });
      writeFileSync(join(root, "src", name), `${lines.join("\n")}\n`);
    }
    await check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("src/ opens no network connections", async () => {
  expect(await forbiddenNetworkUse(join(import.meta.dir, "..", ".."))).toEqual([]);
});

test("the check finds every kind of network use outside src/client/", async () => {
  const lines = [
    'await fetch("x");',
    "const f = globalThis.fetch;",
    'import "net";',
    'import { request } from "node:https";',
    'const tls = require("tls");',
    'await import("node:http2");',
    'export * from "dgram";',
    'import http = require("http");',
    "Bun.serve({ port: 1 });",
    'Bun["listen"]({ port: 1 });',
    "globalThis.Bun.udpSocket({});",
    'Bun.connect({ unix: "/tmp/relay.sock" });',
    "new XMLHttpRequest();",
    'new EventSource("x");',
    'const W = globalThis["WebSocket"];',
  ];
  await withScratchSource({ "a.ts": lines }, async (root) => {
    const expected = [
      "1: fetch",
      "2: fetch",
      '3: "net"',
      '4: "node:https"',
      '5: "tls"',
      '6: "node:http2"',
      '7: "dgram"',
      '8: "http"',
      "9: Bun.serve",
      "10: Bun.listen",
      "11: Bun.udpSocket",
      "12: Bun.connect",
      "13: XMLHttpRequest",
      "14: EventSource",
      "15: WebSocket",
    ];
    expect(await forbiddenNetworkUse(root)).toEqual(expected.map((entry) => `src/a.ts:${entry}`).sort());
  });
});

test("src/client/ may only call fetch and Bun.connect with a unix option", async () => {
  const ok = [
    'await fetch("http://localhost/status", {',
    "  unix: socketPath,",
    "});",
    "await Bun.connect({ unix: socketPath, socket: handlers });",
  ];
  const bad = [
    'await fetch("https://unix.example.com");',
    'await fetch("http://x", { headers: { "x-mode": "unix" } });',
    'await fetch("http://x", { headers: { unix: "1" } });',
    'await fetch("http://x", { method: "POST", body: "unix: 1" });',
    'await Bun.connect({ hostname: "example.com", port: 80 });',
    "const f = fetch;",
    'import { connect } from "node:net";',
    'await fetch("https://example.com", { /* unix: socketPath */ method: "GET" });',
    'await fetch("https://example.com/(");',
    'await fetch("http://localhost/status", { unix: socketPath });',
  ];
  await withScratchSource({ "client/ok.ts": ok, "client/bad.ts": bad }, async (root) => {
    expect(await forbiddenNetworkUse(root)).toEqual([
      "src/client/bad.ts:1: fetch",
      "src/client/bad.ts:2: fetch",
      "src/client/bad.ts:3: fetch",
      "src/client/bad.ts:4: fetch",
      "src/client/bad.ts:5: Bun.connect",
      "src/client/bad.ts:6: fetch",
      'src/client/bad.ts:7: "node:net"',
      "src/client/bad.ts:8: fetch",
      "src/client/bad.ts:9: fetch",
    ]);
  });
});
