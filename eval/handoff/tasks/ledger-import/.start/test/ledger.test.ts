import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";

test("Entries are added and balances are summed by category", () => {
  const ledger = new Ledger();
  ledger.add({ date: "2026-01-01", amountCents: 1250, category: "food", note: "Lunch" });
  ledger.add({ date: "2026-01-02", amountCents: -250, category: "food", note: "" });
  ledger.add({ date: "2026-01-03", amountCents: 700, category: "travel", note: "" });
  expect(ledger.entries.length).toBe(3);
  expect(ledger.balanceByCategory().food).toBe(1000);
  expect(ledger.balanceByCategory().travel).toBe(700);
});

test("A saved ledger can be loaded again", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-visible-"));
  try {
    const path = join(dir, "ledger.json");
    const ledger = Ledger.load(path);
    expect(ledger.entries.length).toBe(0);
    ledger.add({ date: "2026-01-01", amountCents: 350, category: "food", note: "Tea" });
    ledger.save(path);
    expect(Ledger.load(path).entries).toEqual(ledger.entries);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
