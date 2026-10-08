import { TokenBucket } from "./bucket.ts";

export interface LimiterOptions {
  capacity: number;
  refillPerSecond: number;
}

export class KeyedLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly options: LimiterOptions) {}

  check(key: string): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.options.capacity, this.options.refillPerSecond);
      this.buckets.set(key, bucket);
    }
    return bucket.tryTake();
  }
}
