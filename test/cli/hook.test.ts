import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import { MAIN, runRelay } from "../helpers/cli";
import { makeRelayHome } from "../helpers/home";

const MEGABYTE = new Uint8Array(1024 * 1024).fill(0x61);

test("relay hook claude Stop reads 1 MB of standard input and stays silent", async () => {
  expect(await runRelay(["hook", "claude", "Stop"], { stdin: MEGABYTE })).toEqual({ code: 0, stdout: "", stderr: "" });
});

test("relay hook with a missing argument stays silent", async () => {
  expect(await runRelay(["hook", "claude"])).toEqual({ code: 0, stdout: "", stderr: "" });
});

test.each([[["hook", "claude"]], [["hook", "claude", "Stop", "extra"]], [["hook", "claude", "Stop", "--fast"]]])(
  "relay %p reads 1 MB of standard input and stays silent",
  async (args) => {
    expect(await runRelay(args, { stdin: MEGABYTE })).toEqual({ code: 0, stdout: "", stderr: "" });
  },
);

test("a hook usage error reads at most 1 MiB of standard input for at most 200 ms", async () => {
  const reads: [number, number][] = [];
  const code = await runCli({
    argv: ["hook", "claude"],
    cwd: process.cwd(),
    env: process.env,
    homedir: process.env.HOME!,
    uid: process.getuid!(),
    io: { out: () => {}, err: () => {}, stdinIsTTY: false, isTerminal: false,
      readStdin: async (maxBytes, timeoutMs) => (reads.push([maxBytes, timeoutMs]), Buffer.alloc(0)), readLine: async () => null },
  });
  expect({ code, reads }).toEqual({ code: 0, reads: [[1024 * 1024, 200]] });
});

for (const [label, env] of [["a usage error", {}], ["invalid settings", { RELAY_LOG_LEVEL: "loud" }]] as const) {
  test(`relay hook with ${label} exits even when its input never ends`, async () => {
    const args = label === "a usage error" ? ["hook", "claude"] : ["hook", "claude", "Stop"];
    const child = Bun.spawn([process.execPath, "--no-env-file", MAIN, ...args], {
      env: { ...process.env, RELAY_HOME: makeRelayHome(), ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write("{");
    await child.stdin.flush();
    const exited = await Promise.race([child.exited, new Promise<null>((done) => setTimeout(() => done(null), 3000))]);
    if (exited === null) child.kill("SIGKILL");
    child.stdin.end();
    expect(exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
  });
}

test("relay hook --help prints the hook help", async () => {
  const golden = readFileSync(join(import.meta.dir, "golden", "hook.txt"), "utf8");
  expect(await runRelay(["hook", "--help"])).toEqual({ code: 0, stdout: golden, stderr: "" });
});
