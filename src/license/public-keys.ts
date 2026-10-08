// The Ed25519 public keys that sign relay license keys, by signing key ID, each the 32-byte key in
// base64url (the "x" value of its JWK). Public keys only; the private keys live in the website's
// settings. Only "live-" key IDs belong here (add-lifetime-license, design decisions 9 and 13).
export const LICENSE_PUBLIC_KEYS: Readonly<Record<string, string>> = {};
