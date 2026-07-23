import type { Context, Next } from 'hono';

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
      return c.json(
        { success: false, error: { code: 'AUTH_FAILED', message: 'Invalid or missing API key' } },
        401
      );
    }

    return next();
  };
}
