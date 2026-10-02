import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { RuntimeExecutor } from '@/core/runtime/runtime-executor.js';
import { AppError, ValidationError, generateId } from '@/lib/index.js';
import { toInvokeErrorResponse } from '@/lib/envelope.js';

// The request body is the invocation context itself — the caller sends the API payload as-is.
// A body whose only key is an object-valued `context` is also accepted and unwrapped.
const InvocationRequestSchema = z.record(z.unknown());

// The execution id travels in a header so the body stays just `data` / `error`.
const EXECUTION_ID_HEADER = 'Execution-Id';

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
      const { success: _success, meta, ...result } = await executor.invoke({
        service: c.req.param('service'), action: c.req.param('action'),
        context: unwrapContext(parsed.data), executionId, startedAtMs,
      });
      c.header(EXECUTION_ID_HEADER, meta.executionId);
      return c.json(result);
    } catch (caught) {
      const { status, body } = toInvokeErrorResponse(caught);
      c.header(EXECUTION_ID_HEADER, executionId);
      return c.json(body, status as ContentfulStatusCode);
    }
  });
  return router;
}
