// Splits an agent's output into lines (add-provider-adapters, design decision 5). A line is only
// passed on once its newline has arrived, however many pieces it came in, and it is never cut.

export class LineSplitter {
  // ignoreBOM keeps a byte order mark at the start of the output, so the log holds it unchanged.
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  // The pieces of the line that has not ended yet; joined once, when its newline arrives.
  private pending: string[] = [];

  // Returns the lines that this chunk completes, without their newlines.
  push(chunk: Uint8Array | string): string[] {
    return this.split(typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true }));
  }

  // Returns what is left at the end of the output: a last line that has no newline.
  end(): string[] {
    const lines = this.split(this.decoder.decode());
    if (this.pending.length > 0) lines.push(this.take());
    return lines;
  }

  private split(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    let newline: number;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      this.pending.push(text.slice(start, newline));
      lines.push(this.take());
      start = newline + 1;
    }
    if (start < text.length) this.pending.push(text.slice(start));
    return lines;
  }

  private take(): string {
    const line = this.pending.join("");
    this.pending = [];
    return line;
  }
}

// Parses output lines that should hold one JSON value each. An empty line is ignored; a line that
// is not valid JSON is skipped and counted, so the adapter can write the count to the worker log.
export class JsonLineParser {
  skipped = 0;

  parse(line: string): { value: unknown } | null {
    if (line.trim() === "") return null;
    try {
      return { value: JSON.parse(line) };
    } catch {
      this.skipped++;
      return null;
    }
  }
}
