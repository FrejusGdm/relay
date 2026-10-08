import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionState, readConnection, removeConnection, tokenGetter, writeConnection, type ConnectionRecord } from "../../src/t3/connection";
import { memorySecretStore } from "../../src/t3/secrets";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const record: ConnectionRecord = {
  v: 1, url: "http://127.0.0.1:3773/mcp", connected_at: "2026-10-08T00:00:00.000Z",
  expires_at: "2026-11-07T00:00:00.000Z", server_version: "1.0.0",
};

test("connection state uses the expiry and warns from three days before it", () => {
  expect(connectionState(null, new Date(record.connected_at))).toBe("none");
  expect(connectionState(record, new Date(record.connected_at))).toBe("connected");
  expect(connectionState(record, new Date("2026-11-04T00:00:00.000Z"))).toBe("expiring");
  expect(connectionState(record, new Date("2026-11-05T00:00:00.000Z"))).toBe("expiring");
  expect(connectionState(record, new Date(record.expires_at))).toBe("expired");
  expect(connectionState(record, new Date("2026-11-08T00:00:00.000Z"))).toBe("expired");
});

test("connection records use private modes, replace atomically and contain only the five fields", () => {
  const home = mkdtempSync(join(tmpdir(), "relay-t3-connection-"));
  homes.push(home);
  expect(readConnection(home)).toBeNull();
  const privateValue = crypto.randomUUID();
  writeConnection(home, { ...record, access_token: privateValue } as ConnectionRecord);
  const path = join(home, "t3", "connection.json");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(home, "t3")).mode & 0o777).toBe(0o700);
  expect(readFileSync(path, "utf8").includes(privateValue)).toBe(false);
  expect(Object.keys(readConnection(home)!).sort()).toEqual(["connected_at", "expires_at", "server_version", "url", "v"]);
  const next = { ...record, server_version: "1.1.0" };
  writeConnection(home, next);
  expect(readConnection(home)).toEqual(next);
  expect(readdirSync(join(home, "t3"))).toEqual(["connection.json"]);
  removeConnection(home);
  removeConnection(home);
  expect(readConnection(home)).toBeNull();
});

test("tokenGetter reads the current entry under the exact configured URL", async () => {
  const store = memorySecretStore();
  const getToken = tokenGetter(store, record.url);
  expect((await getToken()) === null).toBe(true);
  const token = crypto.randomUUID();
  await store.set(record.url, token);
  expect((await getToken()) === token).toBe(true);
  expect((await store.get(`${record.url}#client`)) === null).toBe(true);
  expect(await store.delete(record.url)).toBe(true);
  expect(await store.delete(record.url)).toBe(false);
  expect((await getToken()) === null).toBe(true);
});
