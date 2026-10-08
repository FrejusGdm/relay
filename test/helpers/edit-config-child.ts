// A program for test/core/config-edit.test.ts, started as `bun edit-config-child.ts <relay folder>
// <account>`: it appends the account's table to config.toml through editConfig, waiting 300 ms
// between reading the file and writing it, so that two of them started together overlap.
import { appendTable, editConfig } from "../../src/core/config/edit";

const [relayHome, id] = process.argv.slice(2) as [string, string];
editConfig({ relayHome, homedir: process.env.HOME!, uid: process.getuid!() }, (text) => {
  Bun.sleepSync(300);
  return appendTable(text, `[accounts."${id}"]`);
});
