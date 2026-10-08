import { expect, test } from "bun:test";
import { countClaims, readVerify } from "../src/claims.ts";

const verify = `# Verification

| Claim | Holds | Evidence |
|---|:---:|---|
| The parser handles quoted commas | yes | test/import.test.ts passes |
| Errors go to standard error | **no** | cli.ts prints them with console.log |
| Duplicates are skipped | unclear | no test covers it |
| CRLF works \\| both endings | \`yes\` | added a test |

Notes after the table.
`;

test("Rows that say no are claims found false and unclear rows are unverified", () => {
  expect(readVerify(verify)).toEqual(["yes", "no", "unclear", "yes"]);
  expect(countClaims(verify, [{ claim: "All tests pass", found: "2 tests fail" }])).toEqual({
    verify_written: true, relay_mismatches: 1, claims_found_false: 2, claims_unverified: 1,
  });
});

test("A missing file or a file without the table is not written", () => {
  const none = { verify_written: false, relay_mismatches: 0, claims_found_false: 0, claims_unverified: 0 };
  expect(countClaims(null, undefined)).toEqual(none);
  expect(countClaims("# Verification\n\nEverything holds.\n", [])).toEqual(none);
  expect(countClaims("| Claim | Evidence |\n|---|---|\n| A | B |\n", [])).toEqual(none);
});
