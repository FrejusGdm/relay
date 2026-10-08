import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import { runRelay } from "../helpers/cli";

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

test("a hook usage error reads standard input to the end", async () => {
  let read = 0;
  const code = await runCli({
    argv: ["hook", "claude"],
    cwd: process.cwd(),
    env: process.env,
    homedir: process.env.HOME!,
    uid: process.getuid!(),
    io: { out: () => {}, err: () => {}, stdinIsTTY: false, readStdinToEnd: async () => (read++, "") },
  });
  expect({ code, read }).toEqual({ code: 0, read: 1 });
});

test("relay hook --help prints the hook help", async () => {
  const golden = readFileSync(join(import.meta.dir, "golden", "hook.txt"), "utf8");
  expect(await runRelay(["hook", "--help"])).toEqual({ code: 0, stdout: golden, stderr: "" });
});
