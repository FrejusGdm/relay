import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importCsv, ImportError } from "./import.ts";
import { Ledger } from "./ledger.ts";
import { formatAmount, parseAmount } from "./money.ts";

const [command, ...args] = process.argv.slice(2);
const path = join(process.cwd(), "ledger.json");
const ledger = Ledger.load(path);

if (command === "import" && args.length === 1) {
  try {
    const { imported, skipped } = importCsv(ledger, readFileSync(args[0]!, "utf8"));
    ledger.save(path);
    console.log(`Imported ${imported} ${imported === 1 ? "entry" : "entries"}, skipped ${skipped} ${skipped === 1 ? "duplicate" : "duplicates"}.`);
  } catch (error) {
    if (error instanceof ImportError) {
      for (const problem of error.errors) console.error(`line ${problem.line}: ${problem.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
} else if (command === "add" && args.length >= 3) {
  const [date, amount, category, note = ""] = args;
  ledger.add({ date: date!, amountCents: parseAmount(amount!), category: category!, note });
  ledger.save(path);
  console.log("Added.");
} else if (command === "balance") {
  const balances = ledger.balanceByCategory();
  for (const category of Object.keys(balances).sort()) {
    console.log(`${category} ${formatAmount(balances[category]!)}`);
  }
} else {
  console.error("Usage: bun src/cli.ts add <date> <amount> <category> [note] | balance | import <file.csv>");
  process.exitCode = 2;
}
