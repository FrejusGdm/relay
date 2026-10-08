import { expect, test } from "bun:test";
import { TokenBucket } from "../src/bucket.ts";
import { KeyedLimiter } from "../src/limiter.ts";

test("Refill preserves the configured rate across frequent calls", () => {
  let now = 0;
  const clock = { now: () => now };
  const bucket = new TokenBucket(5, 5, clock);
  let allowed = 0;
  for (let i = 0; i < 400; i++) {
    now = i * 150;
    if (bucket.tryTake()) allowed++;
  }
  expect(allowed).toBe(304);
});

test("Fractional tokens carry over between calls", () => {
  let now = 0;
  const clock = { now: () => now };
  const bucket = new TokenBucket(5, 5, clock);
  expect(bucket.tryTake(5)).toBe(true);
  now = 300;
  expect(bucket.tryTake()).toBe(true);
  expect(bucket.tryTake()).toBe(false);
  now = 600;
  expect(bucket.tryTake()).toBe(true);
  expect(bucket.tryTake()).toBe(true);
  expect(bucket.tryTake()).toBe(false);
});

test("An hour of refill never exceeds capacity", () => {
  let now = 0;
  const clock = { now: () => now };
  const bucket = new TokenBucket(5, 1, clock);
  expect(bucket.tryTake(5)).toBe(true);
  now = 3_600_000;
  for (let i = 0; i < 5; i++) expect(bucket.tryTake()).toBe(true);
  expect(bucket.tryTake()).toBe(false);
});

test("A bucket works without an injected clock", () => {
  const bucket = new TokenBucket(5, 1);
  for (let i = 0; i < 5; i++) expect(bucket.tryTake()).toBe(true);
});

test("An allowed check has no retry delay", () => {
  let now = 0;
  const clock = { now: () => now };
  const limiter = new KeyedLimiter({ capacity: 2, refillPerSecond: 1, clock });
  expect(limiter.check("a")).toMatchObject({ allowed: true, retryAfterMs: 0 });
});

test("A refused check rounds the retry delay up to a millisecond", () => {
  let now = 0;
  const clock = { now: () => now };
  const limiter = new KeyedLimiter({ capacity: 1, refillPerSecond: 3, clock });
  expect(limiter.check("k").allowed).toBe(true);
  expect(limiter.check("k")).toMatchObject({ allowed: false, retryAfterMs: 334 });
});

test("An idle key is removed when its idle time expires", () => {
  let now = 0;
  const clock = { now: () => now };
  const limiter = new KeyedLimiter({ capacity: 2, refillPerSecond: 1, clock, idleMs: 1000 });
  limiter.check("a");
  now = 500;
  limiter.check("b");
  expect(limiter.size).toBe(2);
  now = 1500;
  limiter.check("b");
  expect(limiter.size).toBe(1);
});

test("A key checked before its idle time expires is kept", () => {
  let now = 0;
  const clock = { now: () => now };
  const limiter = new KeyedLimiter({ capacity: 2, refillPerSecond: 1, clock, idleMs: 1000 });
  limiter.check("a");
  limiter.check("b");
  now = 999;
  limiter.check("a");
  expect(limiter.size).toBe(2);
});

test("Taking more than capacity throws a range error", () => {
  let now = 0;
  const clock = { now: () => now };
  const bucket = new TokenBucket(5, 1, clock);
  expect(() => bucket.tryTake(6)).toThrow(RangeError);
  expect(() => bucket.tryTake(6)).toThrow("n exceeds capacity");
});

test("Each key has an independent bucket", () => {
  let now = 0;
  const clock = { now: () => now };
  const limiter = new KeyedLimiter({ capacity: 1, refillPerSecond: 1, clock });
  expect(limiter.check("a").allowed).toBe(true);
  expect(limiter.check("a").allowed).toBe(false);
  expect(limiter.check("b").allowed).toBe(true);
});
