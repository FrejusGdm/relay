// Task 1.3: bun:ffi must keep working inside the compiled relay program (design.md, Risks).
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { removeTempRelayHomes, tempRelayHome } from "../helpers/relay-home";

afterAll(removeTempRelayHomes);

test("a compiled probe reports the same user ID as id -u", () => {
  const probe = join(tempRelayHome(), "probe");
  const build = Bun.spawnSync(
    [process.execPath, "build", "./test/platform/ffi-probe.ts", "--compile", "--outfile", probe],
    { cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" },
  );
  expect({ code: build.exitCode, stderr: build.stderr.toString() }).toMatchObject({ code: 0 });
  const run = Bun.spawnSync([probe], { stdout: "pipe", stderr: "pipe" });
  const id = Bun.spawnSync(["id", "-u"], { stdout: "pipe" }).stdout.toString();
  expect({ code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }).toEqual({
    code: 0,
    stdout: id,
    stderr: "",
  });
}, 120_000);
