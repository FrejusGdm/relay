import { readSync, writeSync } from "node:fs";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdinIsTTY: boolean;
  readStdinToEnd(): Promise<string>;
  // Reads one answer line from the terminal; null at end of input.
  readLine(): Promise<string | null>;
}

export function processIo(): Io {
  return {
    out: (text) => writeAll(1, text),
    err: (text) => writeAll(2, text),
    stdinIsTTY: process.stdin.isTTY === true,
    async readStdinToEnd() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    readLine: async () => readLineSync(),
  };
}

// Synchronous writes, so that nothing is lost when main.ts calls process.exit. When the reader
// has gone away (for example `relay --help | head -1`), the rest of the output is dropped.
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  try {
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
  } catch (error) {
    if ((error as { code?: string }).code !== "EPIPE") throw error;
  }
}

// Reads byte by byte up to a newline, so nothing after the answer is taken from the terminal that a
// program relay starts next, such as a provider's login, might read.
function readLineSync(): string | null {
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  while (true) {
    let read: number;
    try {
      read = readSync(0, one, 0, 1, null);
    } catch (error) {
      if ((error as { code?: string }).code !== "EAGAIN") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }
    if (read === 0) return bytes.length === 0 ? null : Buffer.from(bytes).toString("utf8");
    if (one[0] === 0x0a) return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
    bytes.push(one[0]!);
  }
}
