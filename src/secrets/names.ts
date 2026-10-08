// File names that often hold secrets (design.md decision 7). An untracked file with such a name
// stops a checkpoint until the person includes it once. Names are compared in lower case.
import { basename } from "node:path";

const EXACT = new Set([
  ".env", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials.json", ".npmrc", ".pypirc",
  ".netrc", "kubeconfig",
]);
const EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"];
// Example files that describe the variables without their values.
const ENV_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);

// `path` is relative to the worktree root; only its last part counts.
export function looksSecret(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (EXACT.has(name)) return true;
  if (name.startsWith(".env.")) return !ENV_EXAMPLES.has(name);
  return EXTENSIONS.some((extension) => name.endsWith(extension));
}
