import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { importCsv, ImportError } from "../src/import.ts";
import { Ledger } from "../src/ledger.ts";

const header = "date,amount,category,note\n";

function problems(ledger: Ledger, text: string) {
  let caught: unknown;
  try {
    importCsv(ledger, text);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ImportError);
  return (caught as ImportError).errors.map((error) => ({ line: error.line, message: error.message }));
}

async function command(text: string, initial?: Ledger) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-acceptance-"));
  try {
    const path = join(dir, "ledger.json");
    const csv = join(dir, "input.csv");
    initial?.save(path);
    writeFileSync(csv, text);
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "import", csv], {
      cwd: dir, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim(), ledger: Ledger.load(path) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("A quoted comma remains in one note field", () => {
  const ledger = new Ledger();
  importCsv(ledger, header + '2026-01-01,12.50,food,"Lunch, with Sam"\n');
  expect(ledger.entries.length).toBe(1);
  expect(ledger.entries[0]?.note).toBe("Lunch, with Sam");
});

test("Doubled quotes become one quote in a note", () => {
  const ledger = new Ledger();
  importCsv(ledger, header + '2026-01-01,7,food,"He said ""hi"""');
  expect(ledger.entries[0]?.note).toBe('He said "hi"');
});

test("Quoted line breaks are preserved and advance later row numbers", () => {
  const ledger = new Ledger();
  importCsv(ledger, header + '2026-01-01,7,food,"First\nSecond"\n');
  expect(ledger.entries[0]?.note).toBe("First\nSecond");
  expect(problems(new Ledger(), header + '2026-01-01,7,food,"First\nSecond"\n2026-13-01,2,food,\n'))
    .toEqual([{ line: 4, message: 'invalid date "2026-13-01"' }]);
});

test("CRLF line endings do not become part of fields", () => {
  const ledger = new Ledger();
  importCsv(ledger, "date,amount,category,note\r\n2026-01-01,7,food,Tea\r\n");
  expect(ledger.entries[0]?.date).toBe("2026-01-01");
  expect(ledger.entries[0]?.amountCents).toBe(700);
  expect(ledger.entries[0]?.category).toBe("food");
  expect(ledger.entries[0]?.note).toBe("Tea");
});

test("A byte order mark before the header is ignored", () => {
  const ledger = new Ledger();
  importCsv(ledger, "\uFEFF" + header + "2026-01-01,7,food,Tea");
  expect(ledger.entries.length).toBe(1);
  expect(ledger.entries[0]?.date).toBe("2026-01-01");
});

test("Header columns are mapped regardless of order and case", () => {
  const ledger = new Ledger();
  importCsv(ledger, "NOTE,Category,AMOUNT,Date\nTea,food,7,2026-01-01");
  expect(ledger.entries[0]?.date).toBe("2026-01-01");
  expect(ledger.entries[0]?.amountCents).toBe(700);
  expect(ledger.entries[0]?.category).toBe("food");
  expect(ledger.entries[0]?.note).toBe("Tea");
});

test("An impossible calendar date is reported on its row", () => {
  expect(problems(new Ledger(), header + "2026-01-01,7,food,\n2026-02-30,2,food,"))
    .toEqual([{ line: 3, message: 'invalid date "2026-02-30"' }]);
});

test("Thousands separators are rejected even in quoted amounts", () => {
  expect(problems(new Ledger(), header + '2026-01-01,"1,000.00",food,'))
    .toEqual([{ line: 2, message: 'invalid amount "1,000.00"' }]);
});

test("A negative amount with one decimal is stored in cents", () => {
  const ledger = new Ledger();
  importCsv(ledger, header + "2026-01-01,-3.5,food,");
  expect(ledger.entries[0]?.amountCents).toBe(-350);
});

test("An invalid row leaves all existing entries unchanged", () => {
  const ledger = new Ledger();
  ledger.add({ date: "2025-12-01", amountCents: 100, category: "old", note: "Original" });
  expect(problems(ledger, header + "2026-01-01,7,food,\n2026-01-02,2,,"))
    .toEqual([{ line: 3, message: "empty category" }]);
  expect(ledger.entries.length).toBe(1);
  expect(ledger.entries[0]?.date).toBe("2025-12-01");
  expect(ledger.entries[0]?.amountCents).toBe(100);
  expect(ledger.entries[0]?.category).toBe("old");
  expect(ledger.entries[0]?.note).toBe("Original");
});

test("An existing entry is skipped with amounts compared in cents", () => {
  const ledger = new Ledger();
  ledger.add({ date: "2026-01-01", amountCents: 350, category: "food", note: "Tea" });
  const result = importCsv(ledger, header + "2026-01-01,3.5,food,Tea\n2026-01-02,7,food,Lunch");
  expect(result.imported).toBe(1);
  expect(result.skipped).toBe(1);
  expect(ledger.entries.length).toBe(2);
});

test("A repeated row within the file is skipped", () => {
  const ledger = new Ledger();
  const result = importCsv(ledger, header + "2026-01-01,3.5,food,Tea\n2026-01-01,3.5,food,Tea");
  expect(result.imported).toBe(1);
  expect(result.skipped).toBe(1);
  expect(ledger.entries.length).toBe(1);
});

test("The command saves new entries and prints the plural summary", async () => {
  const ledger = new Ledger();
  ledger.add({ date: "2026-01-01", amountCents: 350, category: "food", note: "Tea" });
  const result = await command(header + "2026-01-02,7,food,Lunch\n2026-01-03,2,travel,Bus\n2026-01-01,3.5,food,Tea\n2026-01-02,7,food,Lunch", ledger);
  expect(result.stdout).toBe("Imported 2 entries, skipped 2 duplicates.");
  expect(result.code).toBe(0);
  expect(result.ledger.entries.length).toBe(3);
});

test("The command reports invalid rows in line order without saving", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-errors-"));
  try {
    const csv = join(dir, "input.csv");
    writeFileSync(csv, header + "2026-01-01,7,food,\n2026-01-02,12.345,food,\n2026-01-03,2,,");
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "import", csv], {
      cwd: dir, stdout: "pipe", stderr: "pipe",
    });
    const [code, , stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr.trim()).toBe('line 3: invalid amount "12.345"\nline 4: empty category');
    expect(code).toBe(1);
    expect(Ledger.load(join(dir, "ledger.json")).entries.length).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("The command uses singular words for one entry and one duplicate", async () => {
  const result = await command(header + "2026-01-01,3.5,food,Tea\n2026-01-01,3.5,food,Tea");
  expect(result.stdout).toBe("Imported 1 entry, skipped 1 duplicate.");
  expect(result.code).toBe(0);
});
