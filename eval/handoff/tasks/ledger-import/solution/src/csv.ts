export interface CsvRecord {
  line: number;
  fields: string[];
}

export class CsvError extends Error {
  constructor(readonly line: number, message: string) {
    super(message);
  }
}

export function parseCsv(input: string): CsvRecord[] {
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  let line = 1;
  let start = 1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (ch === "\r" && text[i + 1] === "\n") {
        field += "\r\n";
        i++;
        line++;
      } else {
        field += ch;
        if (ch === "\n") line++;
      }
      continue;
    }
    if (ch === ",") {
      fields.push(field);
      field = "";
      closed = false;
    } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      fields.push(field);
      records.push({ line: start, fields });
      fields = [];
      field = "";
      closed = false;
      if (ch === "\r") i++;
      line++;
      start = line;
    } else if (ch === '"' && field === "" && !closed) {
      quoted = true;
    } else {
      if (ch === '"' || closed) throw new CsvError(line, "unexpected quote");
      field += ch;
    }
  }
  if (quoted) throw new CsvError(start, "unclosed quoted field");
  if (text.length > 0 && !text.endsWith("\n")) {
    fields.push(field);
    records.push({ line: start, fields });
  }
  return records;
}
