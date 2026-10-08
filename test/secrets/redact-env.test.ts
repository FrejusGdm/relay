import { expect, test } from "bun:test";
import { redactEnvValues } from "../../src/secrets/redact";

// Values are built at run time, so the repository holds none.
const value = (count: number, seed = "q7") => seed.repeat(Math.ceil(count / seed.length)).slice(0, count);

test.each(["STRIPE_SECRET_KEY", "GITHUB_TOKEN", "APP_SECRET", "DB_PASSWORD", "PASSWORD"])("a value of %s is replaced", (name) => {
  const secret = value(12);
  const result = redactEnvValues(`before ${secret} after\n${secret}`, { [name]: secret });
  expect(result).toBe(`before [redacted: ${name}] after\n[redacted: ${name}]`);
  expect(result).not.toContain(secret);
});

test("a value of 7 characters is left alone", () => {
  const short = value(7);
  expect(redactEnvValues(`x ${short} y`, { API_KEY: short })).toBe(`x ${short} y`);
});

test("a value of exactly 8 characters is replaced", () => {
  const eight = value(8);
  expect(redactEnvValues(eight, { API_KEY: eight })).toBe("[redacted: API_KEY]");
});

test("other names and unset variables are left alone", () => {
  const text = value(20);
  expect(redactEnvValues(text, { HOME: text, KEYRING: text, TOKENS: text, EMPTY_TOKEN: undefined })).toBe(text);
});

test("a value that holds another secret value is replaced whole", () => {
  const inner = value(9, "ab");
  const outer = `${inner}${value(9, "cd")}`;
  const result = redactEnvValues(`${outer} and ${inner}`, { SHORT_TOKEN: inner, LONG_TOKEN: outer });
  expect(result).toBe("[redacted: LONG_TOKEN] and [redacted: SHORT_TOKEN]");
  expect(result).not.toContain(inner);
});

test("each line of a value that spans lines is replaced on its own", () => {
  const first = value(10, "ab");
  const second = value(12, "cd");
  const result = redactEnvValues(`one ${first}\nother text\n${second} two`, { PRIVATE_KEY: `${first}\n${second}` });
  expect(result).toBe("one [redacted: PRIVATE_KEY]\nother text\n[redacted: PRIVATE_KEY] two");
});

test("two values that overlap in the text leave nothing of either", () => {
  const a = "abcdefgh12";
  const b = "12345678xy";
  const result = redactEnvValues(`x abcdefgh12345678xy z`, { A_TOKEN: a, B_TOKEN: b });
  expect(result).toBe("x [redacted: A_TOKEN] z");
  for (const piece of ["abcdefgh", "345678xy"]) expect(result).not.toContain(piece);
});
