import { expect, test } from "bun:test";
import { formatAmount, parseAmount } from "../src/money.ts";

test("Amounts are parsed into cents", () => {
  expect(parseAmount("12.50")).toBe(1250);
  expect(parseAmount("7")).toBe(700);
  expect(parseAmount("-3.25")).toBe(-325);
});

test("Cents are formatted with two decimal places", () => {
  expect(formatAmount(1250)).toBe("12.50");
  expect(formatAmount(-325)).toBe("-3.25");
  expect(formatAmount(0)).toBe("0.00");
});
