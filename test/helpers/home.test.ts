import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeRelayHome } from "./home";

test("each call returns a different folder", () => {
  const first = makeRelayHome();
  const second = makeRelayHome();
  expect(first).not.toBe(second);
  expect(first).not.toBe(process.env.RELAY_HOME);
  expect(existsSync(join(first, "config.toml"))).toBe(false);
});

test("the settings file gets the requested mode", () => {
  const withDefault = makeRelayHome("version = 1\n");
  expect(statSync(join(withDefault, "config.toml")).mode & 0o777).toBe(0o600);

  const withMode = makeRelayHome("version = 1\n", 0o644);
  expect(statSync(join(withMode, "config.toml")).mode & 0o777).toBe(0o644);
});
