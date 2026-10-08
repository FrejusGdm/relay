// Task 1.1: the peer user check through getpeereid (macOS) or SO_PEERCRED (Linux).
import { afterAll, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { peerUid } from "../../src/platform/peer-credentials";
import { removeTempRelayHomes, tempRelayHome } from "../helpers/relay-home";

afterAll(removeTempRelayHomes);

// Bun gives accepted and connected sockets an fd property that its types do not list.
const fdOf = (socket: object) => (socket as { fd?: number }).fd ?? -1;

test("peerUid returns the user ID of the process on the other end", async () => {
  const path = join(tempRelayHome(), "peer.sock");
  const { promise: serverSide, resolve } = Promise.withResolvers<number | null>();
  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        resolve(peerUid(fdOf(socket)));
      },
      data() {},
    },
  });
  try {
    const client = await Bun.connect({ unix: path, socket: { data() {} } });
    expect(await serverSide).toBe(process.getuid!());
    expect(peerUid(fdOf(client))).toBe(process.getuid!());
    client.end();
  } finally {
    server.stop(true);
  }
});

test("peerUid fails closed: an invalid descriptor or a file that is not a socket gives null", () => {
  expect(peerUid(-1)).toBeNull();
  expect(peerUid(1.5)).toBeNull();
  const fd = openSync(join(tempRelayHome(), "plain-file"), "w");
  try {
    expect(peerUid(fd)).toBeNull();
  } finally {
    closeSync(fd);
  }
});
