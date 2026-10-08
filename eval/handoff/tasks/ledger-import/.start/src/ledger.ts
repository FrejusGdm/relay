import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Entry {
  date: string;
  amountCents: number;
  category: string;
  note: string;
}

export class Ledger {
  readonly entries: Entry[] = [];

  add(entry: Entry): void {
    this.entries.push(entry);
  }

  balanceByCategory(): Record<string, number> {
    const balances: Record<string, number> = Object.create(null);
    for (const entry of this.entries) {
      balances[entry.category] = (balances[entry.category] ?? 0) + entry.amountCents;
    }
    return balances;
  }

  static load(path: string): Ledger {
    const ledger = new Ledger();
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8")) as { entries: Entry[] };
      for (const entry of data.entries) ledger.add(entry);
    }
    return ledger;
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify({ entries: this.entries }, null, 2) + "\n");
  }
}
