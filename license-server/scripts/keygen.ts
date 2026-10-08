// bun scripts/keygen.ts <kid> (add-lifetime-license, design decision 13). Creates an Ed25519 key
// pair, writes the private key to ./<kid>.signing-key with mode 0600 and prints only the public
// key line for src/license/public-keys.ts.
import { generateKeyPairSync } from "node:crypto";
import { closeSync, constants, openSync, writeSync } from "node:fs";

const kid = process.argv[2] ?? "";
if (!/^(test|live)-[0-9]+$/.test(kid)) {
  console.error('keygen: the key ID must look like "live-1" or "test-1".');
  process.exit(2);
}

const file = `${kid}.signing-key`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

let fd: number;
try {
  fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(code === "EEXIST" ? `keygen: ${file} already exists. Nothing was changed.` : `keygen: cannot create ${file} (${code}).`);
  process.exit(1);
}
writeSync(fd, `${der}\n`);
closeSync(fd);

const x = publicKey.export({ format: "jwk" }).x;
console.log(`"${kid}": "${x}", // gitleaks:allow`);
console.error(`keygen: the private key is in ${file} (mode 0600). Keep it out of the repository.`);
