import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAIN } from "../helpers/cli";
import { makeRelayHome } from "../helpers/home";

// relay installs its signal handlers before it starts reading standard input. A write of almost
// 1 MiB does not fit in the pipe, so it only finishes once relay is reading, which proves the
// handlers are in place. It stays below relay hook's 1 MiB limit and standard input stays open,
// so relay is still waiting out its 200 ms read when the signal arrives.
test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 143],
] as const)("%s stops relay with exit %d and is logged", async (signal, code) => {
  const relayHome = makeRelayHome();
  const child = spawn(process.execPath, ["--no-env-file", MAIN, "hook", "claude", "Stop"], {
    env: { ...process.env, RELAY_HOME: relayHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<[number | null, string | null]>((resolve) =>
    child.on("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
  );
  await new Promise<void>((resolve, reject) =>
    child.stdin.write(Buffer.alloc(1024 * 1024 - 1, 0x61), (error) => (error ? reject(error) : resolve())),
  );
  child.kill(signal);
  expect(await exited).toEqual([code, null]);
  const lines = readFileSync(join(relayHome, "logs", "hook.log"), "utf8").trim().split("\n");
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ level: "warn", msg: "command interrupted", signal });
});
