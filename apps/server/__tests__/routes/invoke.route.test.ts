import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createApp, type AppDependencies } from '@/app.js';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';
import type { DBAdapter } from '@/core/db/adapter.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import { createCoreSchemaRegistry } from '@/core/schema/index.js';
import { createCoreHandlerRegistry } from '@/core/components/index.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const request = { uri: 'https://example.test/items/{$context.id}', method: 'POST' };
const output = { transformation: { itemResponse: { id: '{$output.id}', caller: '{$context.id}' } } };
const appConfig = { port: 3000, logLevel: 'silent' };

describe('Phase 2 invocation API', () => {
  let db: DBAdapter;
  let app: Hono;
  let calls: Array<{ uri: string; init?: RequestInit }>;
  let upstream: (input: string, init?: RequestInit) => Promise<Response>;
  const build = (deps: AppDependencies = {}, apiKey?: string) => {
    app = createApp({ ...appConfig, apiKey }, db, {
      fetch: (async (input, init) => {
        calls.push({ uri: String(input), init });
        return upstream(String(input), init);
      }) as typeof fetch,
      ...deps,
    }).app;
  };
  const register = async (config: Record<string, unknown> = { request, output }, condition?: string) => {
    const createBody = { service: 'items', action: 'create', componentType: 'rest', config, condition };
    const created = await app.request('/api/v1/services', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    if (created.status === 201) return created.json();
    // Already exists — update via PUT
    const existing = await (await app.request('/api/v1/services/items/actions/create')).json();
    const updated = await app.request('/api/v1/services/items/actions/create', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ componentType: 'rest', config, condition, version: existing.data.version }),
    });
    expect(updated.status).toBe(200);
    return updated.json();
  };
  const invoke = (body: unknown = { context: { id: 7 } }, path = '/api/v1/services/items/create/invoke') =>
    app.request(path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const recorded = async (result: any) => {
    const res = await app.request(`/api/v1/executions/${result.meta.executionId}`);
    expect(res.status).toBe(200);
    const record = (await res.json()).data;
    expect(await db.getExecutionLogs(result.meta.executionId)).toHaveLength(1);
    return record;
  };

  beforeEach(async () => {
    db = createSqliteAdapter(':memory:');
    await db.connect();
    calls = [];
    upstream = async () => json({ id: 'I-1' });
    build();
  });
  afterEach(async () => { await db.disconnect(); });

  it('registers, resolves request/header/body, invokes, reads execution and keeps one audit row', async () => {
    await register({
      request: {
        ...request,
        headers: {
          'x-caller': '{$context.id}', 'x-missing': '{$context.absent}', 'x-null': '{$context.none}',
          'x-embedded-missing': 'Bearer {$context.absent}', 'x-execution-id': 'spoof',
          'content-type': 'multipart/form-data',
        },
        payloadTemplate: { input: '{$context.id}', nested: ['{$context.id}'] },
      }, output,
    });
    const res = await invoke({ context: { id: 7, none: null } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ itemResponse: { id: 'I-1', caller: 7 } });
    expect(calls[0].uri).toBe('https://example.test/items/7');
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('x-caller')).toBe('7');
    expect(headers.get('x-missing')).toBeNull();
    expect(headers.get('x-embedded-missing')).toBeNull();
    expect(headers.get('x-null')).toBeNull();
    expect(headers.get('x-execution-id')).toBe(body.meta.executionId);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ input: 7, nested: [7] });
    expect(await recorded(body)).toMatchObject({ status: 'COMPLETED', attempts: 1, result: body.data });
    const [log] = await db.getExecutionLogs(body.meta.executionId);
    expect(log.requestData).not.toContain('headers');
    expect(JSON.parse(log.responseData!)).toEqual({ id: 'I-1' });
  });

  it.each([{}, null, { context: [] }, { context: {}, config: {} }, { context: { output: {} } }, '{broken'])(
    'returns complete 400 envelope for bad invocation %#', async body => {
      const res = await invoke(body);
      expect(res.status).toBe(400);
      const result = await res.json();
      expect(result).toMatchObject({ success: false, data: null, error: { code: 'VALIDATION_FAILED' } });
      expect(result.meta.executionId).toBeString();
      expect(await db.getExecution(result.meta.executionId)).toBeNull();
      expect(calls).toHaveLength(0);
    }
  );

  it('returns correlated 404s without recording an unresolved definition', async () => {
    const res = await invoke();
    const result = await res.json();
    expect(res.status).toBe(404);
    expect(result.error.message).toBe('Service not found: items/create');
    expect(await db.getExecutionLogs(result.meta.executionId)).toEqual([]);
    expect((await app.request('/api/v1/executions/missing')).status).toBe(404);
  });

  it('skips before env resolution, capability guards, or limiter', async () => {
    await register({
      request: { ...request, auth: { basic: { username: 'user', password: '{$env.MISSING}' } } },
      resilience: { rateLimit: { requests: 1, windowMs: 60000 } },
    }, '{$context.id} == null');
    for (let index = 0; index < 2; index += 1) {
      const result = await (await invoke()).json();
      expect(result).toMatchObject({ success: true, data: null, skippedExecution: true });
      expect(await recorded(result)).toMatchObject({ status: 'COMPLETED', attempts: 0, result: null });
      expect((await db.getExecutionLogs(result.meta.executionId))[0].status).toBe('skipped');
    }
    expect(calls).toHaveLength(0);
  });

  it('maps failed validation, preserves raw null and records the injected wrapper error', async () => {
    upstream = async () => json({ id: null, message: false });
    await register({ request, output: {
      ...output, default: { id: 'must-not-apply' },
      validation: { rules: [{ expression: '{$output.id} != null', message: 'fallback', errorPath: '{$output.message}' }] },
    } });
    const res = await invoke();
    const result = await res.json();
    expect(res.status).toBe(422);
    expect(result.data).toBeNull();
    expect(result.error).toEqual({
      code: 'VALIDATION_FAILED', message: 'false',
      details: { expression: '{$output.id} != null', errorPath: '{$output.message}' },
    });
    const record = await recorded(result);
    expect(record.result.itemResponse).toMatchObject({
      id: null, caller: 7, error: { code: 'VALIDATION_FAILED', details: [{ path: '{$output.id}' }] },
    });
    expect(JSON.parse((await db.getExecutionLogs(result.meta.executionId))[0].responseData!)).toEqual(record.result);
  });

  it('preserves upstream failure as primary even when rules fail, and still transforms', async () => {
    upstream = async () => json({ id: null }, 400);
    await register({ request, output: {
      ...output, validation: { rules: [{ expression: '{$output.id} != null' }] },
    }, resilience: { retryCount: 2, retryDelay: 1, retryOn: [400] } });
    const res = await invoke();
    const result = await res.json();
    expect(res.status).toBe(502);
    expect(result.error.code).toBe('EXTERNAL_ERROR');
    expect((await recorded(result)).result.itemResponse).toMatchObject({
      id: null, error: { code: 'EXTERNAL_ERROR', downstream: { status: 400 } },
    });
    expect(calls).toHaveLength(1);
  });

  it('records actual attempts on retry success and exhaustion; budget is per invocation', async () => {
    await register({ request, resilience: {
      retryCount: 2, retryDelay: 1, rateLimit: { requests: 1, windowMs: 60000 },
    } });
    upstream = async () => calls.length < 3 ? json({}, 503) : json({ ok: true });
    const result = await (await invoke()).json();
    expect(result.success).toBe(true);
    expect((await recorded(result)).attempts).toBe(3);
    const limited = await invoke();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await recorded(await limited.json())).attempts).toBe(0);
    expect(calls).toHaveLength(3);
    await register({ request, resilience: { retryCount: 2, retryDelay: 1 } });
    upstream = async () => json({}, 500);
    const failed = await (await invoke()).json();
    expect((await recorded(failed)).attempts).toBe(3);
  });

  it('guards every unsupported capability before resolving credentials or dispatching', async () => {
    await register({
      request: {
        ...request, auth: { basic: { username: 'user', password: '{$env.MISSING}' } },
        ssl: { cert: '{$env.CERT}', key: '{$env.KEY}' }, contentType: 'multipart/form-data',
      },
      timeout: { connect: 1, socket: 1, idle: 1 },
      resilience: {
        circuitBreaker: { failureThreshold: 1, windowSize: 1, openDuration: 1, halfOpenMaxAttempts: 1 },
        rateLimit: { requests: 1, windowMs: 60000 },
      },
    });
    for (let index = 0; index < 2; index += 1) {
      const res = await invoke();
      const result = await res.json();
      expect(res.status).toBe(501);
      expect(result.error.details.unsupported).toHaveLength(7);
      expect((await recorded(result)).attempts).toBe(0);
    }
    expect(calls).toHaveLength(0);
  });

  it('reports missing env before transport and records it', async () => {
    build({ env: {} });
    await register({ request: { ...request, uri: '{$env.MISSING}' } });
    const res = await invoke();
    const result = await res.json();
    expect(res.status).toBe(500);
    expect(result.error.code).toBe('ENV_REF_UNRESOLVED');
    expect((await recorded(result)).attempts).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it.each([200, 500])('scrubs echoed env secrets in output, errors, context and both rows (%i)', async status => {
    const secret = 'private/value+"quoted"';
    build({ env: { CREDENTIAL: secret, SHORT: 'xy' } });
    upstream = async (_input, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe(secret);
      return json({ id: 'xy', echo: secret, [secret]: encodeURIComponent(secret), password: secret }, status);
    };
    await register({
      request: { ...request, headers: { Authorization: '{$env.CREDENTIAL}', 'X-Short': '{$env.SHORT}' } },
    });
    const res = await invoke({ context: { id: 7, innocuous: secret, password: 'literal-password' } });
    const text = await res.text();
    expect(text).not.toContain('private');
    expect(text).not.toContain('xy');
    const result = JSON.parse(text);
    const record = await recorded(result);
    const audit = JSON.stringify([record, await db.getExecutionLogs(result.meta.executionId)]);
    expect(audit).not.toContain('private');
    expect(audit).not.toContain('literal-password');
    expect(audit).not.toContain('xy');
    const definition = await db.findComponent('items', 'create');
    expect(JSON.stringify(definition?.config)).toContain('{$env.CREDENTIAL}');
  });

  it('enforces deadlines through body reads and classifies stream failures', async () => {
    await register({ request, timeout: { response: 5 } });
    upstream = async () => new Response(new ReadableStream({ start() {} }), {
      headers: { 'content-type': 'application/json' },
    });
    const timeout = await invoke();
    const result = await timeout.json();
    expect(timeout.status).toBe(504);
    expect((await recorded(result)).attempts).toBe(1);
    upstream = async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('sensitive transport text')); },
    }));
    const failed = await invoke();
    expect(failed.status).toBe(502);
    expect((await failed.json()).error.code).toBe('CONNECTION_ERROR');
  });

  it.each([null, false, 0, '', 'plain', [1, 2]])('passes through JSON scalar/array %#', async value => {
    upstream = async () => json(value);
    await register({ request });
    const result = await (await invoke()).json();
    expect(result.data).toEqual(value);
    expect((await recorded(result)).result).toEqual(value);
  });

  it('malformed JSON can use defaults while success audit retains the raw null', async () => {
    upstream = async () => new Response('{broken', { headers: { 'content-type': 'application/json' } });
    await register({ request, output: { default: { id: 'fallback' }, ...output } });
    const result = await (await invoke()).json();
    expect(result.data.itemResponse.id).toBe('fallback');
    expect(JSON.parse((await db.getExecutionLogs(result.meta.executionId))[0].responseData!)).toBeNull();
  });

  it('does not send runtime output in fallback JSON/form payloads and GET has no body', async () => {
    await register({ request: { ...request, contentType: 'application/x-www-form-urlencoded' } });
    await invoke({ context: { id: 7, a: 1, nested: { b: 2 }, none: null } });
    expect(calls[0].init?.body).toBe('id=7&a=1&nested=%7B%22b%22%3A2%7D');
    await register({ request });
    await invoke();
    expect(calls[1].init?.body).toBe('{"id":7}');
    await register({ request: { ...request, method: 'GET' } });
    await invoke();
    expect(calls[2].init?.body).toBeUndefined();
  });

  it('records malformed stored conditions, unknown handlers and unexpected handler failures', async () => {
    await register();
    const row = await db.findComponent('items', 'create');
    await db.updateComponent(row!.id, { condition: 'bad(' });
    const malformed = await (await invoke()).json();
    expect(malformed.error.code).toBe('TRANSFORMATION_ERROR');
    expect((await recorded(malformed)).attempts).toBe(0);
    await db.updateComponent(row!.id, { condition: '{$context.id} != null', componentType: 'missing' });
    const unknown = await (await invoke()).json();
    expect(unknown.error.code).toBe('UNKNOWN_COMPONENT_TYPE');
    expect((await recorded(unknown)).attempts).toBe(0);
    await db.updateComponent(row!.id, { componentType: 'rest' });
    await db.updateComponent(row!.id, {
      config: { request: { uri: 'https://example.test/{$context.missing}', method: 'POST' } },
    });
    const unresolved = await (await invoke({ context: { id: 7 } })).json();
    expect(unresolved.error.code).toBe('TRANSFORMATION_ERROR');
    expect((await recorded(unresolved)).attempts).toBe(1);
    expect(calls).toHaveLength(0);
    await db.updateComponent(row!.id, { config: { request, output } });
    build({ handlers: createCoreHandlerRegistry().register({
      componentType: 'rest', displayName: 'Broken',
      async execute() { throw new Error('never leak this'); },
    }) });
    const broken = await (await invoke()).json();
    expect(broken.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect((await recorded(broken)).attempts).toBe(1);
  });

  it('adds a component solely through schemas and handlers, preserving the generic pipeline', async () => {
    build({
      schemas: createCoreSchemaRegistry().register('acme', z.object({ output: z.unknown() })),
      handlers: createCoreHandlerRegistry().register({
        componentType: 'acme', displayName: 'Acme',
        async execute(params) {
          expect(params.context.context.output).toEqual({});
          return { data: { id: params.context.context.id } };
        },
      }),
    });
    const res = await app.request('/api/v1/services', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'items', action: 'create', componentType: 'acme', config: { output } }),
    });
    expect(res.status).toBe(201);
    const result = await (await invoke()).json();
    expect(result.data).toEqual({ itemResponse: { id: 7, caller: 7 } });
    expect((await recorded(result)).attempts).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('protects invoke and execution retrieval while health remains public', async () => {
    build({}, 'test-key');
    expect((await invoke()).status).toBe(401);
    expect((await app.request('/api/v1/executions/x')).status).toBe(401);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/api/v1/executions/x', {
      headers: { Authorization: 'Bearer test-key' },
    })).status).toBe(404);
  });

  it('redacts sensitive fields before a short secret can rename their keys', async () => {
    build({ env: { TOKEN: 'a' } });
    upstream = async () => json({ password: 'hunter2' });
    await register({ request: { ...request, headers: { Authorization: '{$env.TOKEN}' } } });
    const result = await (await invoke({ context: { id: 7, password: 'hunter2' } })).json();
    expect(JSON.stringify(result)).not.toContain('hunter2');
    const audit = JSON.stringify([await recorded(result), await db.getExecutionLogs(result.meta.executionId)]);
    expect(audit).not.toContain('hunter2');
    expect(calls[0].init?.body).toBe('{"id":7,"password":"hunter2"}');
  });

  it('retains secrets during partial resolution failure, including failed transformed output', async () => {
    build({ env: { TOKEN: 'private-credential' } });
    await register({
      request: { ...request, headers: { A: '{$env.TOKEN}', B: '{$env.MISSING}' } },
      output: { transformation: { out: { echo: '{$context.echo}' } } },
    });
    const result = await (await invoke({ context: { echo: 'private-credential' } })).json();
    expect(result.error.code).toBe('ENV_REF_UNRESOLVED');
    const audit = JSON.stringify([await recorded(result), await db.getExecutionLogs(result.meta.executionId)]);
    expect(audit).not.toContain('private-credential');
    expect(calls).toHaveLength(0);
  });

  it('preserves rate-limit control fields and Retry-After with a one-character secret', async () => {
    build({ env: { TOKEN: 'e' } });
    await register({
      request: { ...request, headers: { Authorization: '{$env.TOKEN}' } },
      resilience: { rateLimit: { requests: 1, windowMs: 60000 } },
    });
    await invoke();
    const res = await invoke();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    const result = await res.json();
    expect(result.error.details.retryAfterSeconds).toBeNumber();
    expect((await recorded(result)).result.error.code).toBe('RATE_LIMITED');
  });

  it('does not move a credential into an unredacted validation message or mapped field', async () => {
    upstream = async () => json({ id: null, password: 'hunter2' });
    await register({ request, output: {
      validation: { rules: [{ expression: '{$output.id} != null', errorPath: '{$output.password}' }] },
      transformation: { out: { innocent: '{$output.password}' } },
    } });
    const result = await (await invoke()).json();
    expect(result.error.message).toBe('***');
    const audit = JSON.stringify([await recorded(result), await db.getExecutionLogs(result.meta.executionId)]);
    expect(audit).not.toContain('hunter2');
    expect(audit).toContain('***');
  });
});
