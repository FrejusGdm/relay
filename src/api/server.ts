// The listener of the local API (design.md decision 3, the local-api spec). It listens only on a
// Unix socket. For every connection it asks the kernel for the connecting user and closes the
// connection, without reading or answering, when that user is not the daemon's own user or
// cannot be found out.
import type { Socket } from "bun";
import type { Logger } from "../core/log";
import { peerUid } from "../platform/peer-credentials";
import { Http1Connection, REQUEST_DEADLINE_MS } from "./http1";
import type { Router } from "./router";

export interface ApiServer {
  // Stops accepting connections, lets open ones finish for up to waitMs, then closes the rest.
  stop(waitMs?: number): Promise<void>;
}

interface ServerOptions {
  socketPath: string;
  router: Router;
  log: Logger;
  allowedUid?: number;   // tests inject another user ID to see a refusal
}

type Connection = Socket<Http1Connection | undefined>;

// Bun gives accepted sockets an fd property that its types do not list. Without a number the
// peer check fails, and the connection is refused.
function fdOf(socket: Connection): number {
  const fd = (socket as unknown as { fd?: unknown }).fd;
  return typeof fd === "number" ? fd : -1;
}

export function startApiServer(opts: ServerOptions): ApiServer {
  const allowedUid = opts.allowedUid ?? process.getuid!();
  const open = new Set<Connection>();
  const listener = Bun.listen<Http1Connection | undefined>({
    unix: opts.socketPath,
    data: undefined,
    socket: {
      open(socket) {
        const uid = peerUid(fdOf(socket));
        if (uid === null || uid !== allowedUid) {
          opts.log.warn("peer_rejected", { uid });
          socket.terminate();
          return;
        }
        open.add(socket);
        socket.data = new Http1Connection(
          { write: (bytes) => socket.write(bytes), end: () => socket.end() },
          {
            handle: async (request) => {
              try {
                return await opts.router.handle(request);
              } catch (error) {
                // Only the error's name: an engine's message can quote paths or command output.
                opts.log.error("request_failed", { error_name: error instanceof Error ? error.name : typeof error });
                throw error;
              }
            },
            allow: (path) => opts.router.allow(path),
            onDone: (done) => opts.log.debug("request", { ...done }),
          },
        );
      },
      data(socket, chunk) {
        socket.data?.receive(chunk);
      },
      drain(socket) {
        socket.data?.flush();
      },
      close(socket) {
        open.delete(socket);
        socket.data?.closed();
      },
      error(socket) {
        open.delete(socket);
        socket.data?.closed();
      },
    },
  });

  return {
    async stop(waitMs = REQUEST_DEADLINE_MS) {
      listener.stop(false);
      const deadline = Date.now() + waitMs;
      while (open.size > 0 && Date.now() < deadline) await Bun.sleep(20);
      for (const socket of open) socket.terminate();
      listener.stop(true);
    },
  };
}
