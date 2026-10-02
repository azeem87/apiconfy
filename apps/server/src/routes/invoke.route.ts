import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { RuntimeExecutor } from '@/core/runtime/runtime-executor.js';
import { AppError, ValidationError, generateId } from '@/lib/index.js';
import { toInvocationFailure } from '@/lib/envelope.js';

// The request body is the invocation context itself — the caller sends the API payload as-is.
// A body whose only key is an object-valued `context` is also accepted and unwrapped.
const InvocationRequestSchema = z.record(z.unknown());

function unwrapContext(body: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(body);
  const wrapped = body.context;
  const isWrapped = keys.length === 1 && keys[0] === 'context'
    && wrapped !== null && typeof wrapped === 'object' && !Array.isArray(wrapped);
  return isWrapped ? wrapped as Record<string, unknown> : body;
}

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
      const { success: _success, ...result } = await executor.invoke({
        service: c.req.param('service'), action: c.req.param('action'),
        context: unwrapContext(parsed.data), executionId, startedAtMs,
      });
      return c.json(result);
    } catch (caught) {
      const failure = toInvocationFailure(caught, executionId, startedAtMs);
      // Surface the upstream's own status (e.g. 401) instead of the gateway's generic 502.
      const downstreamStatus = failure.error.code === 'EXTERNAL_ERROR'
        ? (failure.error.details as { downstream?: { status?: number } } | undefined)?.downstream?.status
        : undefined;
      const error = caught instanceof AppError ? caught : new AppError('Internal server error', 'INTERNAL_ERROR');
      const statusCode = downstreamStatus ?? error.statusCode;
      const { error: failed, meta } = failure;
      const downstream = (failed.details as { downstream?: { body?: unknown } } | undefined)?.downstream;
      const details = failed.code === 'EXTERNAL_ERROR' && downstream ? { body: downstream.body } : failed.details;
      return c.json({ error: { code: failed.code, message: failed.message, details }, meta },
        statusCode as ContentfulStatusCode);
    }
  });
  return router;
}
