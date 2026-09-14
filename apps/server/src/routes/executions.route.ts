import { Hono } from 'hono';
import type { ExecutionRecord } from '@/core/db/adapter.js';
import { NotFoundError, ok } from '@/lib/index.js';

export interface ExecutionQuery {
  get(executionId: string): Promise<ExecutionRecord | null>;
}

export function executionsRoute(executions: ExecutionQuery): Hono {
  const router = new Hono();
  router.get('/v1/executions/:executionId', async c => {
    const id = c.req.param('executionId');
    const record = await executions.get(id);
    if (!record) throw new NotFoundError(`Execution not found: ${id}`);
    return c.json(ok(record));
  });
  return router;
}
