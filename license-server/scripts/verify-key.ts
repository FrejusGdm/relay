// bun scripts/verify-key.ts <key> --public-key <x> --kid <kid>: checks a license key against one
// public key with relay's own checker, test keys allowed. A development tool for the test-mode run
// (add-lifetime-license, task 8.2); the relay command never allows test keys.
import { parseArgs } from "node:util";
import { verifyLicenseKey } from "../../src/license/key";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: { "public-key": { type: "string" }, kid: { type: "string" } },
  allowPositionals: true,
});
const [key] = positionals;
if (positionals.length !== 1 || key === undefined || values["public-key"] === undefined || values.kid === undefined) {
  console.error("usage: bun scripts/verify-key.ts <key> --public-key <x> --kid <kid>");
  process.exit(2);
}

const result = verifyLicenseKey(key, { [values.kid]: values["public-key"] }, { allowTestKeys: true });
if (result.ok) {
  console.log(`valid: license ${result.license.licenseId}, issued ${result.license.issued}`);
} else {
  console.log(`not valid: ${result.problem}`);
  process.exit(1);
}
