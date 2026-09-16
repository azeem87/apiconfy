import { Hono } from 'hono';
import type { ComponentRegistry } from '@/services/component-registry.service.js';
import type { ComponentView } from '@/core/types.js';
import { maskEnvRefs } from '@/core/env-ref/index.js';
import { ok, okPaged } from '@/lib/envelope.js';
import { parsePagination } from '@/lib/pagination.js';

function toResponse(record: ComponentView): ComponentView {
  return { ...record, config: maskEnvRefs(record.config) };
}

export function servicesRoute(registry: ComponentRegistry): Hono {
  const router = new Hono();

  router.post('/v1/services', async (c) => {
    const body = await c.req.json().catch(() => null);
    const record = await registry.create(body);
    return c.json(ok(toResponse(record)), 201);
  });

  router.put('/v1/services/:service/actions/:action', async (c) => {
    const service = c.req.param('service');
    const action = c.req.param('action');
    const body = await c.req.json().catch(() => null);
    const record = await registry.update(service, action, body);
    return c.json(ok(toResponse(record)), 200);
  });

  router.get('/v1/services', async (c) => {
    const { limit, offset } = parsePagination(c.req.query());
    const filters = {
      service: c.req.query('service'),
      componentType: c.req.query('componentType'),
    };
    const page = await registry.list(filters, limit, offset);
    return c.json(okPaged(page.items.map(toResponse), {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    }));
  });

  router.get('/v1/services/:service/actions', async (c) => {
    const records = await registry.listByService(c.req.param('service'));
    return c.json(ok(records.map(toResponse)));
  });

  router.get('/v1/services/:service/actions/:action', async (c) => {
    const record = await registry.get(c.req.param('service'), c.req.param('action'));
    return c.json(ok(toResponse(record)));
  });

  router.delete('/v1/services/:service/actions/:action', async (c) => {
    const service = c.req.param('service');
    const action = c.req.param('action');
    await registry.remove(service, action);
    return c.json(ok({ deleted: true, service, action }));
  });

  return router;
}
