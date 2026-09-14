import { expect, it } from 'bun:test';
import { createApp } from '@/app.js';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';

it('executes through two real HTTP servers and returns a queryable redacted execution', async () => {
  const requests: Array<{ path: string; executionId: string | null; body: unknown }> = [];
  const upstream = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const body = await req.json();
      requests.push({
        path: new URL(req.url).pathname, executionId: req.headers.get('x-execution-id'), body,
      });
      return Response.json({ id: 'network-1', echo: req.headers.get('authorization') }, { status: 201 });
    },
  });
  const db = createSqliteAdapter(':memory:');
  await db.connect();
  const { app } = createApp({ port: 0, logLevel: 'silent' }, db, { env: { UPSTREAM_TOKEN: 'local-test-credential' } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
  try {
    expect((await fetch(new URL('/health', server.url))).status).toBe(200);
    const registration = await fetch(new URL('/api/v1/services', server.url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'network', action: 'create', componentType: 'rest',
        condition: '$.context.id != null',
        config: {
          request: {
            uri: `${upstream.url}items/$.context.id`, method: 'POST',
            headers: { Authorization: '$env.UPSTREAM_TOKEN' },
            payloadTemplate: { number: '$.context.id' },
          },
          response: {
            validation: { rules: [{ expression: '$.response.id exists' }] },
            transformation: { networkResponse: { id: '$.response.id', echo: '$.response.echo' } },
          },
        },
      }),
    });
    expect(registration.status).toBe(201);
    const invocation = await fetch(new URL('/api/v1/services/network/create/invoke', server.url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: { id: 42, password: 'caller-password' } }),
    });
    expect(invocation.status).toBe(200);
    const result = await invocation.json();
    expect(result.data).toEqual({ networkResponse: { id: 'network-1', echo: '***' } });
    expect(requests).toEqual([{ path: '/items/42', executionId: result.meta.executionId, body: { number: 42 } }]);
    const retrieved = await fetch(new URL(`/api/v1/executions/${result.meta.executionId}`, server.url));
    expect(retrieved.status).toBe(200);
    const execution = (await retrieved.json()).data;
    expect(execution).toMatchObject({ status: 'COMPLETED', attempts: 1, context: { password: '***' } });
    expect(await db.getExecutionLogs(result.meta.executionId)).toHaveLength(1);
    const skipped = await fetch(new URL('/api/v1/services/network/create/invoke', server.url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"context":{"id":null}}',
    });
    expect((await skipped.json()).skippedExecution).toBe(true);
    expect(requests).toHaveLength(1);
  } finally {
    await server.stop(true);
    await upstream.stop(true);
    await db.disconnect();
  }
});
