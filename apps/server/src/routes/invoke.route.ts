import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { RuntimeExecutor } from '@/core/runtime/runtime-executor.js';
import { AppError, ValidationError, generateId } from '@/lib/index.js';

const InvocationRequestSchema = z.object({ context: z.record(z.unknown()) }).strict();

export function invokeRoute(executor: RuntimeExecutor): Hono {
  const router = new Hono();
  router.post('/v1/services/:service/:action/invoke', async c => {
    const executionId = generateId();
    const startedAtMs = Date.now();
    try {
      const parsed = InvocationRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', parsed.error.issues.map(issue => ({
          path: issue.path, message: issue.message,
        })));
      }
      if (Object.hasOwn(parsed.data.context, 'output')) {
        throw new ValidationError('Invalid request body', [
          { path: ['context', 'output'], message: 'context.output is reserved for accumulated results' },
        ]);
      }
      return c.json(await executor.invoke({
        service: c.req.param('service'), action: c.req.param('action'),
        context: parsed.data.context, executionId, startedAtMs,
      }));
    } catch (caught) {
      const error = caught instanceof AppError ? caught : new AppError('Internal server error', 'INTERNAL_ERROR');
      const retryAfter = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (error.code === 'RATE_LIMITED' && retryAfter) c.header('Retry-After', String(retryAfter));
      return c.json({
        success: false, data: null,
        error: { code: error.code, message: error.message, details: error.details },
        meta: { executionId, durationMs: Date.now() - startedAtMs },
      }, error.statusCode as ContentfulStatusCode);
    }
  });
  return router;
}
