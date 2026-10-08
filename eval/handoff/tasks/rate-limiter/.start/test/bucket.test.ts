import { expect, test } from "bun:test";
import { TokenBucket } from "../src/bucket.ts";

test("A new bucket allows its capacity and then refuses a request", () => {
  const bucket = new TokenBucket(3, 1);
  expect(bucket.tryTake()).toBe(true);
  expect(bucket.tryTake()).toBe(true);
  expect(bucket.tryTake()).toBe(true);
  expect(bucket.tryTake()).toBe(false);
});

test("Taking two tokens uses two tokens", () => {
  const bucket = new TokenBucket(3, 1);
  expect(bucket.tryTake(2)).toBe(true);
  expect(bucket.tryTake(2)).toBe(false);
  expect(bucket.tryTake()).toBe(true);
});

test("A bucket with capacity one refuses a second immediate call", () => {
  const bucket = new TokenBucket(1, 1);
  expect(bucket.tryTake()).toBe(true);
  expect(bucket.tryTake()).toBe(false);
});
