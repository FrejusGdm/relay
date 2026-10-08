import { expect, test } from "bun:test";
import { printable, quote } from "../../src/core/quote";

test("quote writes a value like JSON.stringify", () => {
  expect(quote('a "b" \\ c\n')).toBe(JSON.stringify('a "b" \\ c\n'));
});

test("quote and printable escape C0 and C1 controls, DEL and direction marks", () => {
  expect(quote("\u001b[31mred")).toBe('"\\u001b[31mred"');
  expect(quote("\u009b31mred")).toBe('"\\u009b31mred"');
  expect(printable("/tmp/\u001b[31m\u007f\u009b‮ x")).toBe("/tmp/\\u001b[31m\\u007f\\u009b\\u202e\\u2028x");
});

test("printable keeps ordinary text, accents and emoji", () => {
  expect(printable("/Users/josué/projets ✓ 🚀")).toBe("/Users/josué/projets ✓ 🚀");
});
