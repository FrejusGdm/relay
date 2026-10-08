export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(readonly capacity: number, readonly refillPerSecond: number) {
    this.tokens = capacity;
    this.last = Date.now();
  }

  tryTake(n = 1): boolean {
    if (n > this.capacity) return false;
    const now = Date.now();
    const elapsedSeconds = (now - this.last) / 1000;
    const refill = Math.floor(elapsedSeconds * this.refillPerSecond);
    if (refill > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refill);
      this.last = now;
    }
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
