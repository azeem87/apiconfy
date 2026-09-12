import type { Context, Next } from 'hono';
import { AuthError } from '@/lib/index.js';

export function authMiddleware(apiKey?: string) {
  return async (c: Context, next: Next) => {
    if (!apiKey) {
      return next();
    }

    const authHeader = c.req.header('Authorization');
    const key = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!key || key !== apiKey) {
      throw new AuthError('Invalid or missing API key');
    }

    return next();
  };
}
