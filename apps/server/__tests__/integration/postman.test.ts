import { expect, it } from 'bun:test';
import { createApp } from '@/app.js';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';

interface CollectionItem {
  name: string;
  item?: CollectionItem[];
  request?: { method: string; url: string | { raw: string }; body?: { raw?: string } };
}

it('runs every ordered REST and Script Postman example against deterministic local upstreams', async () => {
  const collection = await Bun.file(new URL('../../../../postman/apiconfy.postman_collection.json', import.meta.url)).json();
  const folders = collection.item as CollectionItem[];
  const invocation = folders.find(item => item.name === 'REST')?.item?.find(item => item.name === 'Invoke');
  expect(invocation).toBeDefined();
  const script = folders.find(item => item.name === 'Script');
  expect(script).toBeDefined();

  const db = createSqliteAdapter(':memory:');
  await db.connect();
  const { app, drainExecutionQueue } = createApp({ port: 0, logLevel: 'silent' }, db, {
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
  const replace = (value: string) => value
    .replaceAll('{{base_url}}', 'http://local.test')
    .replaceAll('{{upstream_url}}', 'http://upstream.test')
    .replaceAll('{{execution_id}}', executionId);

  const executeItem = async (item: CollectionItem) => {
    const request = item.request!;
    const rawUrl = typeof request.url === 'string' ? request.url : request.url.raw;
    const url = replace(rawUrl);
    // Execution recording is queued off the response path — drain so lookup requests are deterministic.
    await drainExecutionQueue();
    const result = await app.request(url, {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      body: request.body?.raw ? replace(request.body.raw) : undefined,
    });
    const expected = /^\d{3}/.exec(item.name)?.[0];
    expect(result.status, item.name).toBe(expected ? Number(expected) : url.endsWith('/services') ? 201 : 200);
    const body = await result.json();
    if (url.endsWith('/invoke') && body.meta?.executionId) executionId = body.meta.executionId;
    return body;
  };

  try {
    let restCount = 0;
    for (const group of invocation!.item!) {
      for (const item of group.item!) {
        const body = await executeItem(item);
        if (item.name === '2. Invoke mapped echo') expect(body.data.echoResponse.customerId).toBe('demo-123');
        if (item.name === '5. Invoke form echo') expect(body.data.formEchoResponse.label).toBe('space & plus +');
        if (item.name === '7. Invoke empty-body default') {
          expect(body.data.defaultResponse).toEqual({ status: 'empty', customerId: 'demo-123' });
        }
        restCount += 1;
      }
    }
    expect(restCount).toBe(25);

    const tls = folders.find(item => item.name === 'REST')?.item?.find(item => item.name === 'TLS Certificates');
    expect(tls?.item).toHaveLength(14);
    for (const item of tls!.item!) await executeItem(item);

    let scriptCount = 0;
    for (const group of script!.item ?? []) {
      for (const item of group.item ?? []) {
        const body = await executeItem(item);
        if (item.name === 'Invoke simple script') {
          expect(body.data).toEqual({ sum: 5 });
        }
        if (item.name === 'Invoke complex script') {
          expect(body.data.calculateTotalResponse.total).toBeCloseTo(110, 10);
          expect(body.data.calculateTotalResponse.label).toBe('Order for Ada');
          expect(body.data.calculateTotalResponse.echoOk).toBe(true);
          expect(typeof body.data.calculateTotalResponse.echoExecution).toBe('string');
          expect(body.data.customer.verified).toBe(true);
          expect(body.data.auditMarker.touchedBy).toBe('calc-script');
        }
        if (item.name === 'Invoke complex script — condition false') {
          expect(body).toMatchObject({ success: true, data: null, skippedExecution: true });
        }
        if (item.name === '500 — expression is not a function') {
          expect(body.error.details).toEqual({ reason: 'not-a-function' });
        }
        if (item.name === '500 — expression threw') {
          expect(body.error.details).toEqual({ reason: 'threw' });
        }
        if (item.name === '500 — contribution not serializable') {
          expect(body.error.details).toEqual({ reason: 'not-serializable' });
        }
        if (item.name === '504 — infinite loop') {
          expect(body.error.code).toBe('TIMEOUT');
        }
        scriptCount += 1;
      }
    }
    expect(scriptCount).toBe(19);
  } finally {
    await db.disconnect();
  }
});
