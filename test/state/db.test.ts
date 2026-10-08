// Task 4.2: opening relay.db, and replacing a missing, damaged or old one.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { databasePath, openDatabase, SCHEMA_VERSION, streamEpoch } from "../../src/state/db";
import { removeTempRelayHomes, tempRelayHome } from "../helpers/relay-home";

afterAll(removeTempRelayHomes);

const userVersion = (db: Database) => db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;

test("a missing file is created at user_version 1, with mode 0600 and a stream epoch", () => {
  const relayHome = tempRelayHome();
  const opened = openDatabase(relayHome);
  expect(opened.rebuilt).toBe("missing");
  expect(SCHEMA_VERSION).toBe(1);
  expect(userVersion(opened.db)).toBe(1);
  expect(statSync(databasePath(relayHome)).mode & 0o777).toBe(0o600);
  expect(streamEpoch(opened.db)).toMatch(/^[0-9a-f]{16}$/);
  const epoch = streamEpoch(opened.db);
  opened.db.close();

  const again = openDatabase(relayHome);
  expect(again.rebuilt).toBeNull();
  expect(streamEpoch(again.db)).toBe(epoch);
  again.db.close();
});

test("a file of random bytes is renamed to relay.db.broken-<timestamp> and replaced", () => {
  const relayHome = tempRelayHome();
  writeFileSync(databasePath(relayHome), crypto.getRandomValues(new Uint8Array(8192)));
  const opened = openDatabase(relayHome, () => new Date("2026-10-08T12:34:56.789Z"));
  expect(opened.rebuilt).toBe("damaged");
  expect(opened.brokenFile).toBe(join(relayHome, "relay.db.broken-20261008T123456789Z"));
  expect(existsSync(opened.brokenFile!)).toBe(true);
  expect(userVersion(opened.db)).toBe(1);
  opened.db.close();
});

test("a file at user_version 0 is deleted and replaced, with a new stream epoch", () => {
  const relayHome = tempRelayHome();
  const old = new Database(databasePath(relayHome), { create: true });
  old.exec("CREATE TABLE leftover (x INTEGER); PRAGMA user_version = 0;");
  old.close();
  const opened = openDatabase(relayHome);
  expect(opened.rebuilt).toBe("old_schema");
  expect(userVersion(opened.db)).toBe(1);
  expect(opened.db.query("SELECT name FROM sqlite_master WHERE name = 'leftover'").all()).toEqual([]);
  expect(readdirSync(relayHome).filter((name) => name.includes("broken"))).toEqual([]);
  opened.db.close();
});
