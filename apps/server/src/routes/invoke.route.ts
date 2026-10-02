import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { RuntimeExecutor } from '@/core/runtime/runtime-executor.js';
import { AppError, ValidationError, generateId } from '@/lib/index.js';
import { toInvocationFailure } from '@/lib/envelope.js';

// The request body is the invocation context itself — the caller sends the API payload as-is.
const InvocationRequestSchema = z.record(z.unknown());

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
      return c.json(await executor.invoke({
        service: c.req.param('service'), action: c.req.param('action'),
        context: parsed.data, executionId, startedAtMs,
      }));
    } catch (caught) {
      const failure = toInvocationFailure(caught, executionId, startedAtMs);
      // Surface the upstream's own status (e.g. 401) instead of the gateway's generic 502.
      const downstreamStatus = failure.error.code === 'EXTERNAL_ERROR'
        ? (failure.error.details as { downstream?: { status?: number } } | undefined)?.downstream?.status
        : undefined;
      const error = caught instanceof AppError ? caught : new AppError('Internal server error', 'INTERNAL_ERROR');
      const statusCode = downstreamStatus ?? error.statusCode;
      return c.json(failure, statusCode as ContentfulStatusCode);
    }
  });
  return router;
}
