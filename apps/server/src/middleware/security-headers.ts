import type { Context, Next } from 'hono';

/**
 * Baseline hardening headers (security-review-phase2.md A12).
 *
 * Deliberately no CORS headers: the API is same-origin by default, and a wildcard would let any
 * page read authenticated responses if a key ever reached a browser. Add an explicit origin
 * allowlist here if a browser client is ever a real consumer.
 */
export async function securityHeaders(c: Context, next: Next) {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  return next();
}
