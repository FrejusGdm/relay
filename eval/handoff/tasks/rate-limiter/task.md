# Fix the refill bug and make time injectable

The rate limiter in `src/` lets fewer requests through than configured. Fix it and extend it as below. Keep `bun test` passing and add tests for what you change.

## Acceptance criteria

1. Refill is exact: over any period a bucket allows at most `capacity + rate × elapsed seconds` requests, and fractional tokens carry over between calls.
2. Both classes accept an optional `clock` (`{ now(): number }`, milliseconds); the default uses `Date.now()`, so existing constructor calls keep working. `TokenBucket` takes it as a third constructor argument and `KeyedLimiter` as a `clock` field of its options object.
3. `KeyedLimiter` forgets a key that has not been checked for `idleMs` (an option, default 60000) and exposes `size`, the number of keys it tracks, as a read-only property like `Map.size`. The option `idleMs` is a field of the same options object.
4. `check(key)` returns `{ allowed: boolean; retryAfterMs: number }`; `retryAfterMs` is 0 when allowed and otherwise the time until one token is available, rounded up to a whole millisecond.
5. `tryTake(n)` with `n` larger than the capacity throws `RangeError("n exceeds capacity")`.
