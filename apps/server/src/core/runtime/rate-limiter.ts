import type { RateLimitConfig } from '@/core/types.js';

export type { RateLimitConfig };

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTimeMs: number;
}

export interface RateLimiter {
  consume(key: string, config: RateLimitConfig): Promise<RateLimitResult>;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  capacity: number;
  windowMs: number;
}

export class InMemoryTokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
    const now = this.now();
    const previous = this.buckets.get(key);
    const bucket = previous?.capacity === config.requests && previous.windowMs === config.windowMs
      ? previous
      : { tokens: config.requests, lastRefillMs: now, capacity: config.requests, windowMs: config.windowMs };
    const refillPerMs = config.requests / config.windowMs;
    const clock = Math.max(now, bucket.lastRefillMs);
    const tokens = Math.min(config.requests, bucket.tokens + (clock - bucket.lastRefillMs) * refillPerMs);
    const allowed = tokens >= 1;
    const remaining = allowed ? tokens - 1 : tokens;
    this.buckets.set(key, { ...bucket, tokens: remaining, lastRefillMs: clock });
    return {
      allowed,
      limit: config.requests,
      remaining: Math.floor(remaining),
      resetTimeMs: clock + Math.ceil(Math.max(0, 1 - remaining) / refillPerMs),
    };
  }
}
