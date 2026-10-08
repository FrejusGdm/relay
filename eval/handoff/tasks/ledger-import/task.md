# Add CSV import to the ledger tool

The ledger tool in `src/` can add entries and show balances by category. Add a command that imports entries from a CSV file. Keep `bun test` passing and add tests for what you change.

The command line is `bun src/cli.ts <command>`. It reads and writes `ledger.json` in the current directory.

## Acceptance criteria

1. `bun src/cli.ts import <file.csv>` reads CSV as defined by RFC 4180: a header row with the columns `date`, `amount`, `category`, `note` in any order and any letter case; quoted fields with commas, doubled quotes and line breaks; LF or CRLF line endings; an optional final line break; and an optional UTF-8 byte order mark.
2. A row is valid when its date is a real calendar date written `YYYY-MM-DD`, its amount is an optional minus sign, digits and at most two decimals (no thousands separators), and its category is not empty. The note may be empty. Fields are used as written, without trimming spaces.
3. Import is all or nothing. If any row is invalid, nothing is added, the command prints one line per problem on standard error, in line order, and exits with code 1. Each line is `line <n>: <message>`, where `<n>` is the physical line on which the row starts: the header is line 1, and a line break inside a quoted field makes the later rows start one line further down. The messages are `invalid date "<value>"`, `invalid amount "<value>"` and `empty category`, and a row with several problems reports them in that order. A row with a number of fields other than four reports `expected 4 fields, found <n>`, and a header without one of the four columns reports `missing column <name>` on line 1.
4. A row equal in all four fields to an existing entry, or to an earlier row of the same file, is skipped. Amounts are compared in cents, so `3.5` and `3.50` are equal.
5. On success the command saves the ledger, prints `Imported 12 entries, skipped 3 duplicates.` on standard output (with `1 entry` and `1 duplicate` in the singular) and exits with code 0.
6. A new module `src/import.ts` exports the function `importCsv(ledger, text)` and the class `ImportError`. `importCsv` is synchronous, accepts the same CSV text as the command (including a leading byte order mark), adds the valid entries to the `Ledger` it is given and returns `{ imported, skipped }` (two numbers), or adds nothing and throws an `ImportError` whose `errors` is a list of `{ line, message }` with the same line numbers and messages as the command.
