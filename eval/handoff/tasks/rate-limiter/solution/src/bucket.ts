export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = capacity;
    this.last = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) * this.refillPerSecond) / 1000);
    this.last = now;
  }

  tryTake(n = 1): boolean {
    if (n > this.capacity) throw new RangeError("n exceeds capacity");
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  msUntil(n = 1): number {
    this.refill();
    return this.tokens >= n ? 0 : Math.ceil(((n - this.tokens) * 1000) / this.refillPerSecond);
  }
}
