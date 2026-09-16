import { expect, it } from 'bun:test';
import { createApp } from '@/app.js';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';

interface CollectionItem {
  name: string;
  item?: CollectionItem[];
  request?: { method: string; url: string; body?: { raw?: string } };
}

it('runs every ordered Phase 2 Postman example against deterministic local upstreams', async () => {
  const collection = await Bun.file(new URL('../../../../postman/apiconfy.postman_collection.json', import.meta.url)).json();
  const rest = (collection.item as CollectionItem[]).find(item => item.name === 'REST');
  const invocation = rest?.item?.find(item => item.name === 'Invoke');
  expect(invocation).toBeDefined();
  const db = createSqliteAdapter(':memory:');
  await db.connect();
  const { app } = createApp({ port: 0, logLevel: 'silent' }, db, {
    env: {},
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/health') return app.request('/health');
      if (path.startsWith('/status/')) return new Response(null, { status: Number(path.split('/').pop()) });
      const form = new Headers(init?.headers).get('content-type')?.startsWith('application/x-www-form-urlencoded');
      return Response.json(form
        ? { form: Object.fromEntries(new URLSearchParams(String(init?.body))) }
        : { json: JSON.parse(String(init?.body)) });
    }) as typeof fetch,
  });
  let executionId = '';
  let count = 0;
  const replace = (value: string) => value
    .replaceAll('{{base_url}}', 'http://local.test')
    .replaceAll('{{upstream_url}}', 'http://upstream.test')
    .replaceAll('{{execution_id}}', executionId);
  try {
    for (const group of invocation!.item!) {
      for (const item of group.item!) {
        const request = item.request!;
        const url = replace(request.url);
        const result = await app.request(url, {
          method: request.method,
          headers: { 'content-type': 'application/json' },
          body: request.body?.raw ? replace(request.body.raw) : undefined,
        });
        const expected = /^\d{3}/.exec(item.name)?.[0];
        expect(result.status, item.name).toBe(expected ? Number(expected) : url.endsWith('/services') ? 201 : 200);
        const body = await result.json();
        if (url.endsWith('/invoke') && body.meta?.executionId) executionId = body.meta.executionId;
        if (item.name === '2. Invoke mapped echo') expect(body.data.echoResponse.customerId).toBe('demo-123');
        if (item.name === '5. Invoke form echo') expect(body.data.formEchoResponse.label).toBe('space & plus +');
        if (item.name === '7. Invoke empty-body default') {
          expect(body.data.defaultResponse).toEqual({ status: 'empty', customerId: 'demo-123' });
        }
        if (item.name.startsWith('429')) expect(result.headers.get('Retry-After')).toBeString();
        count += 1;
      }
    }
    expect(count).toBe(29);
  } finally {
    await db.disconnect();
  }
});
