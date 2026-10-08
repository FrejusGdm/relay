// Values that look like real secrets, built while the test runs so that none is ever committed.
import { randomInt } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function randomText(alphabet: string, length: number): string {
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
}

// A GitHub personal access token: ghp_ and 36 letters and digits.
export function fakeGithubToken(): string {
  return "ghp" + "_" + randomText("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 36);
}

// An AWS access key ID: AKIA and 16 characters of the base32 alphabet.
export function fakeAwsKey(): string {
  return "AK" + "IA" + randomText("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16);
}

// The files under `dir` whose content contains `text`; none when `dir` does not exist.
export function filesContaining(dir: string, text: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && readFileSync(path, "utf8").includes(text));
}

// Integration tests need the real gitleaks, and fail with this message instead of skipping.
export function requireGitleaks(): void {
  if (Bun.which("gitleaks") === null) {
    throw new Error("These tests need gitleaks 8.28 or newer on PATH. Install it (brew install gitleaks) and run them again.");
  }
}
