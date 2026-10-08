// Asks the kernel which user is on the other end of a Unix socket (design.md decision 4). Any
// failure returns null, and the caller refuses the connection.
import { getpeereid, getsockopt } from "./libc";

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const UCRED_BYTES = 12;   // struct ucred { int32 pid; uint32 uid; uint32 gid; }

export function peerUid(fd: number): number | null {
  if (!Number.isInteger(fd) || fd < 0) return null;
  try {
    if (process.platform === "darwin") {
      const uid = new Uint32Array(1);
      const gid = new Uint32Array(1);
      return getpeereid(fd, uid, gid) === 0 ? uid[0]! : null;
    }
    if (process.platform === "linux") {
      const ucred = new Uint32Array(UCRED_BYTES / 4);
      const length = new Uint32Array([UCRED_BYTES]);
      const bytes = new Uint8Array(ucred.buffer);
      if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, bytes, length) !== 0 || length[0] !== UCRED_BYTES) return null;
      return ucred[1]!;
    }
    return null;
  } catch {
    return null;
  }
}
