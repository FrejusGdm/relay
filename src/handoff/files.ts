// relay's private files for handoffs under RELAY_HOME (add-relay-switch, design decision 21): every
// folder has mode 0700 and every file mode 0600, and a file is written to a temporary file and then
// renamed, so a crash leaves the old or the new content, never half of it.
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJobId } from "../job/id";

export function jobFolder(relayHome: string, jobId: string): string {
  if (!isJobId(jobId)) throw new Error(`relay refused to use the job ID ${JSON.stringify(jobId)} in a path.`);
  return join(relayHome, "jobs", jobId);
}

// Creates `folder` and the missing folders above it with mode 0700. A folder that already exists
// keeps its mode, except `folder` itself, which is set to 0700.
export function makePrivateFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = lstatSync(folder);
  if (!stat.isDirectory()) throw new Error(`${folder} is not a folder.`);
  if ((stat.mode & 0o777) !== 0o700) chmodSync(folder, 0o700);
}

// `afterWrite` lets a test stop between the write and the rename, as a crash would.
export function writePrivateFile(path: string, text: string, afterWrite?: () => void): void {
  makePrivateFolder(dirname(path));
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  afterWrite?.();
  renameSync(temporary, path);
}
