import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdinIsTTY: boolean;
  readStdinToEnd(): Promise<string>;
  // Whether a person can answer a question: standard input and standard output are both terminals.
  isTerminal: boolean;
  // One line of standard input without its line ending, or null at the end of the input.
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
    async readLine() {
      const lines = createInterface({ input: process.stdin, terminal: false });
      try {
        for await (const line of lines) return line;
        return null;
      } finally {
        lines.close();
      }
    },
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
