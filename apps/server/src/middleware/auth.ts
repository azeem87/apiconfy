import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { AuthError } from '@/lib/index.js';

/** Constant-time comparison — avoids leaking key length/prefix via response timing. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function authMiddleware(apiKey?: string) {
  return async (c: Context, next: Next) => {
    if (!apiKey) {
      return next();
    }

    const authHeader = c.req.header('Authorization');
    const key = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!key || !safeCompare(key, apiKey)) {
      throw new AuthError('Invalid or missing API key');
    }

    return next();
  };
}
