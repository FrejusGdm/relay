import { expect, test } from "bun:test";
import { add } from "../src/math.ts";

test("Addition works with positive numbers", () => {
  expect(add(2, 3)).toBe(5);
});

test("Addition works with negative numbers", () => {
  expect(add(-2, -3)).toBe(-5);
});
