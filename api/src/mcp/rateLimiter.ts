/**
 * Agent HQ MCP Server — Token-Bucket Rate Limiter
 *
 * Simple per-process rate limiter. In the stdio model there is exactly one
 * MCP client, so process-level limiting is sufficient for v1.
 */

export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private lastRefill: number;
  private readonly refillIntervalMs: number;

  constructor(requestsPerMinute: number) {
    this.maxTokens = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.lastRefill = Date.now();
    // Refill one token every (60000 / rpm) ms
    this.refillIntervalMs = 60_000 / requestsPerMinute;
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  allow(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }
}
