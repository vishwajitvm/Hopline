/**
 * Classic token-bucket rate limiter: allows short bursts up to `burst`,
 * refilling at `ratePerSecond`. O(1) per call, no timers.
 */
export class TokenBucket {
  #tokens;
  #lastRefill;

  constructor({ ratePerSecond, burst, now = Date.now }) {
    this.ratePerSecond = ratePerSecond;
    this.burst = burst;
    this.now = now;
    this.#tokens = burst;
    this.#lastRefill = now();
  }

  #refill() {
    const current = this.now();
    const elapsedSeconds = (current - this.#lastRefill) / 1000;
    this.#lastRefill = current;
    this.#tokens = Math.min(this.burst, this.#tokens + elapsedSeconds * this.ratePerSecond);
  }

  take(count = 1) {
    this.#refill();
    if (this.#tokens < count) return false;
    this.#tokens -= count;
    return true;
  }

  /** True when at least `count` tokens are available, without using them. */
  canTake(count = 1) {
    this.#refill();
    return this.#tokens >= count;
  }

  /** A full bucket carries no state worth keeping (used to prune per-client maps). */
  get isFull() {
    this.#refill();
    return this.#tokens >= this.burst;
  }
}
