// A process that has exited but is not reaped yet (a zombie) counts as gone, so relay daemon stop
// and the worker state do not wait for a parent that is slow to reap it.
import { expect, test } from "bun:test";
import { processExists } from "../../src/state/queries";

test("a running process exists and an unknown one does not", () => {
  expect(processExists(process.pid)).toBe(true);
  expect(processExists(2_147_483_000)).toBe(false);
});

test.skipIf(process.platform !== "linux")("a zombie process counts as gone on Linux", async () => {
  // The shell starts a short sleep, then becomes `sleep 30`, which never reaps that child.
  const parent = Bun.spawn(["sh", "-c", "sleep 0.1 & echo $!; exec sleep 30"], { stdout: "pipe" });
  try {
    const { value } = await parent.stdout.getReader().read();
    const zombie = Number(new TextDecoder().decode(value).trim());
    await Bun.sleep(500);
    expect(Bun.spawnSync(["ps", "-o", "stat=", "-p", String(zombie)], { stdout: "pipe" }).stdout.toString().trim()).toStartWith("Z");
    expect(processExists(zombie)).toBe(false);
  } finally {
    parent.kill("SIGKILL");
  }
});
