// Compiled into a program by test/platform/compiled-ffi.test.ts (task 1.3), and by hand for macOS.
// It checks the two C library calls from inside a compiled binary: it prints the user ID that the
// peer check reports for its own connection, and exits 1 if flock does not refuse a second lock.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLock } from "../../src/platform/file-lock";
import { peerUid } from "../../src/platform/peer-credentials";

const dir = mkdtempSync(join(tmpdir(), "relay-probe-"));
try {
  const first = tryLock(join(dir, "probe.lock"));
  const second = tryLock(join(dir, "probe.lock"));
  if (first === null || second !== null) {
    console.error("flock did not behave as expected");
    process.exit(1);
  }
  first.release();

  const { promise, resolve } = Promise.withResolvers<number | null>();
  const server = Bun.listen({
    unix: join(dir, "probe.sock"),
    socket: {
      open(socket) {
        resolve(peerUid((socket as { fd?: number }).fd ?? -1));
      },
      data() {},
    },
  });
  const client = await Bun.connect({ unix: join(dir, "probe.sock"), socket: { data() {} } });
  console.log(String(await promise));
  client.end();
  server.stop(true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
