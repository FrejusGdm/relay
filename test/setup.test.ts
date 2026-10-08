import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { spawnSync } from "bun";

test("HOME and RELAY_HOME are new folders inside the system temporary folder", () => {
  const temp = realpathSync(tmpdir()) + sep;
  const realHome = userInfo().homedir;
  for (const value of [process.env.HOME, process.env.RELAY_HOME]) {
    expect(value).toBeDefined();
    expect(value!.startsWith(temp)).toBe(true);
    expect(value).not.toBe(realHome);
  }
});

test("credential variables are removed", () => {
  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(process.env.OPENAI_API_KEY).toBeUndefined();
});

const GUARD_MESSAGE = (name: string) =>
  `Tests must not start the real ${name}. Use test/fixtures/fake-provider instead.\n`;

test.each(["claude", "codex"])("starting %s without an env option runs the guard program", (name) => {
  for (const result of [Bun.spawnSync([name, "--version"]), Bun.spawnSync({ cmd: [name, "--version"] }), spawnSync([name, "--version"])]) {
    expect(result.exitCode).toBe(97);
    expect(result.stderr.toString()).toBe(GUARD_MESSAGE(name));
  }
});

test.each(["claude", "codex"])("Bun.spawn of %s without an env option runs the guard program", async (name) => {
  const child = Bun.spawn([name, "--version"], { stderr: "pipe" });
  expect(await child.exited).toBe(97);
  expect(await new Response(child.stderr).text()).toBe(GUARD_MESSAGE(name));
});

test.each(["claude", "codex"])("Bun.which finds the guard program for %s", (name) => {
  expect(Bun.which(name)).toBe(join(import.meta.dir, "fixtures", "fake-provider", "guard-bin", name));
});

test("a child sees the test HOME and no planted settings variables", () => {
  const script = 'printf "%s|%s|%s|%s|%s|%s" "$HOME" "$ANTHROPIC_API_KEY" "$XDG_CONFIG_HOME" "$GIT_DIR" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_NOSYSTEM"';
  const result = Bun.spawnSync(["sh", "-c", script], { cwd: mkdtempSync(join(process.env.HOME!, "child-")) });
  expect(result.stdout.toString()).toBe(`${process.env.HOME}|||||1`);
});
