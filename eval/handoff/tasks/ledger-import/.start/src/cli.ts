import { join } from "node:path";
import { Ledger } from "./ledger.ts";
import { formatAmount, parseAmount } from "./money.ts";

const [command, ...args] = process.argv.slice(2);
const path = join(process.cwd(), "ledger.json");
const ledger = Ledger.load(path);

if (command === "add" && args.length >= 3) {
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
  console.error("Usage: bun src/cli.ts add <date> <amount> <category> [note] | balance");
  process.exitCode = 2;
}
