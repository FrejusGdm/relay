import { expect, test } from "bun:test";
import { add, sub } from "../src/math.ts";

test("Addition remains correct", () => {
  expect(add(2, 3)).toBe(5);
});

test("Subtraction returns a positive difference", () => {
  expect(sub(5, 3)).toBe(2);
});

test("Subtraction returns a negative difference", () => {
  expect(sub(3, 5)).toBe(-2);
});
