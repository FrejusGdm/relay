import { expect, test } from "bun:test";
import { looksSecret } from "../../src/secrets/names";

test.each([
  ".env", ".env.local", ".env.production", "config/.env.local", "ID_RSA", "id_dsa", "id_ecdsa", "keys/id_ed25519",
  "server.pem", "tls.key", "prod.p12", "cert.PFX", "credentials.json", ".npmrc", ".pypirc", ".netrc", "kubeconfig",
  "release.keystore", "app.jks",
])("%s looks like it holds secrets", (name) => {
  expect(looksSecret(name)).toBe(true);
});

test.each([
  ".env.example", ".env.sample", ".env.template", ".ENV.EXAMPLE", "env.ts", "pem.md", "README.md", "src/key.ts",
  "id_rsa.pub", "credentials.json.md", "my.env", "keys/", "environment",
])("%s does not", (name) => {
  expect(looksSecret(name)).toBe(false);
});
