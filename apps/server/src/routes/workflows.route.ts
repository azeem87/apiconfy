import { Hono } from 'hono';
import type { WorkflowService } from '@/services/workflow.service.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ValidationError, generateId, ok } from '@/lib/index.js';
import { toInvokeErrorResponse } from '@/lib/envelope.js';

const EXECUTION_ID_HEADER = 'Execution-Id';

export function workflowsRoute(workflows: WorkflowService): Hono {
  const router = new Hono();

  router.post('/v1/workflows', async c => {
    const record = await workflows.create(await c.req.json().catch(() => null));
    return c.json(ok(record), 201);
  });

  // The body is the workflow's initial context, same convention as the service invoke route.
  router.post('/v1/workflows/:workflowName/execute', async c => {
    const executionId = generateId();
    try {
      const body = await c.req.json().catch(() => null);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError('Invalid request body', [{ path: [], message: 'Expected a JSON object' }]);
      }
      const result = await workflows.execute(
        c.req.param('workflowName'), body as Record<string, unknown>, executionId,
      );
      c.header(EXECUTION_ID_HEADER, result.executionId);
      return c.json({ data: result.data });
    } catch (caught) {
      const { status, body } = toInvokeErrorResponse(caught);
      c.header(EXECUTION_ID_HEADER, executionId);
      return c.json(body, status as ContentfulStatusCode);
    }
  });

  return router;
}
