import { TokenBucket } from "./bucket.ts";
import type { Clock } from "./bucket.ts";

export interface LimiterOptions {
  capacity: number;
  refillPerSecond: number;
  clock?: Clock;
  idleMs?: number;
}

export class KeyedLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; lastSeen: number }>();
  private readonly clock: Clock;
  private readonly idleMs: number;

  constructor(private readonly options: LimiterOptions) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.idleMs = options.idleMs ?? 60000;
  }

  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.clock.now();
    for (const [trackedKey, entry] of this.buckets) {
      if (now - entry.lastSeen >= this.idleMs) this.buckets.delete(trackedKey);
    }
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.options.capacity, this.options.refillPerSecond, this.clock), lastSeen: now };
      this.buckets.set(key, entry);
    }
    entry.lastSeen = now;
    return entry.bucket.tryTake()
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: entry.bucket.msUntil() };
  }

  get size(): number {
    return this.buckets.size;
  }
}
