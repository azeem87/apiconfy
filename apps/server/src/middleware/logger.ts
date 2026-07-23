import type { Context, Next } from 'hono';
import type { Logger } from '@/lib/index.js';

export function requestLogger(logger: Logger) {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
      },
      'request'
    );
  };
}
