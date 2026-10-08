import { CsvError, parseCsv } from "./csv.ts";
import type { Entry, Ledger } from "./ledger.ts";
import { parseAmount } from "./money.ts";

export class ImportError extends Error {
  constructor(readonly errors: { line: number; message: string }[]) {
    super("CSV import failed");
    this.name = "ImportError";
  }
}

function validDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

function key(entry: Entry): string {
  return JSON.stringify([entry.date, entry.amountCents, entry.category, entry.note]);
}

export function importCsv(ledger: Ledger, text: string): { imported: number; skipped: number } {
  let records;
  try {
    records = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvError) throw new ImportError([{ line: error.line, message: error.message }]);
    throw error;
  }
  const header = records.shift()?.fields.map((name) => name.toLowerCase()) ?? [];
  const columns = ["date", "amount", "category", "note"];
  const errors: { line: number; message: string }[] = [];
  for (const column of columns) {
    if (!header.includes(column)) errors.push({ line: 1, message: `missing column ${column}` });
  }
  if (errors.length > 0) throw new ImportError(errors);
  const pending: Entry[] = [];
  const seen = new Set(ledger.entries.map(key));
  let skipped = 0;
  for (const record of records) {
    const { line, fields } = record;
    if (fields.length !== 4) {
      errors.push({ line, message: `expected 4 fields, found ${fields.length}` });
      continue;
    }
    const date = fields[header.indexOf("date")]!;
    const amount = fields[header.indexOf("amount")]!;
    const category = fields[header.indexOf("category")]!;
    const note = fields[header.indexOf("note")]!;
    const before = errors.length;
    if (!validDate(date)) errors.push({ line, message: `invalid date "${date}"` });
    let amountCents = 0;
    try {
      amountCents = parseAmount(amount);
    } catch {
      errors.push({ line, message: `invalid amount "${amount}"` });
    }
    if (category === "") errors.push({ line, message: "empty category" });
    if (errors.length !== before) continue;
    const entry = { date, amountCents, category, note };
    const identity = key(entry);
    if (seen.has(identity)) skipped++;
    else {
      seen.add(identity);
      pending.push(entry);
    }
  }
  if (errors.length > 0) throw new ImportError(errors);
  for (const entry of pending) ledger.add(entry);
  return { imported: pending.length, skipped };
}
