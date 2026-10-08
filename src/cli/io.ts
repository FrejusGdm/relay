import { readSync, writeSync } from "node:fs";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdinIsTTY: boolean;
  readStdinToEnd(): Promise<string>;
  // Whether a person can answer a question: standard input and standard output are both terminals.
  isTerminal: boolean;
  // Reads standard input until its end, maxBytes or timeoutMs, whichever comes first, and then
  // stops reading. Returns at most maxBytes.
  readStdin(maxBytes: number, timeoutMs: number): Promise<Buffer>;
  // One line of standard input without its line ending, or null at the end of the input. It reads
  // byte by byte, so nothing after the answer is taken from a program relay starts next.
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
    isTerminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
    readStdin: (maxBytes, timeoutMs) => readBounded(maxBytes, timeoutMs),
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

function readBounded(maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const stdin = process.stdin;
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", finish);
      stdin.off("error", finish);
      stdin.pause();
      done(Buffer.concat(chunks).subarray(0, maxBytes));
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= maxBytes) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on("data", onData);
    stdin.once("end", finish);
    stdin.once("error", finish);
  });
}
