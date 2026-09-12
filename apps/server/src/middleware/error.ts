import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, type Logger } from '@/lib/index.js';

export function errorHandler(logger: Logger) {
  return (err: Error, c: Context) => {
    if (err instanceof AppError) {
      logger.warn({ code: err.code, message: err.message, path: c.req.path }, 'App error');
      return c.json(
        {
          success: false,
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        },
        err.statusCode as ContentfulStatusCode
      );
    }

    logger.error({ err, path: c.req.path }, 'Unhandled error');
    return c.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        },
      },
      500
    );
  };
}
