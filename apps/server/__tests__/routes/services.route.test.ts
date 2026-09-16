import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createApp } from '@/app.js';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';
import type { DBAdapter } from '@/core/db/adapter.js';
import type { AppConfig } from '@/config.js';
import type { Hono } from 'hono';

const config = { port: 3000, logLevel: 'silent' } satisfies AppConfig;

const body = (overrides: Record<string, unknown> = {}) => ({
  service: 'customer-service',
  action: 'create_customer',
  componentType: 'rest',
  description: 'Creates a customer in the CRM',
  config: { request: { uri: 'https://api.example.com/customers', method: 'POST' } },
  ...overrides,
});

const post = (app: Hono, payload: unknown) => app.request('/api/v1/services', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

describe('services routes', () => {
  let db: DBAdapter;
  let app: Hono;

  beforeEach(async () => {
    db = createSqliteAdapter(':memory:');
    await db.connect();
    app = createApp(config, db).app;
  });

  afterEach(async () => {
    await db.disconnect();
  });

  describe('POST /api/v1/services', () => {
    it('registers and returns 201 in the standard envelope', async () => {
      const res = await post(app, body());
      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.service).toBe('customer-service');
      expect(json.data.id).toBeTruthy();
      expect(json.meta).toEqual({});
    });

    it('returns 200, not 201, when the upsert updated an existing definition', async () => {
      const first = await post(app, body());
      expect(first.status).toBe(201);
      const second = await post(app, body({ description: 'changed' }));
      expect(second.status).toBe(200);
      expect((await second.json()).data.description).toBe('changed');
    });

    it('upserts on repeat rather than creating a duplicate', async () => {
      const first = await (await post(app, body())).json();
      const second = await (await post(app, body({ description: 'changed' }))).json();

      expect(second.data.id).toBe(first.data.id);
      expect(second.data.description).toBe('changed');

      const list = await (await app.request('/api/v1/services')).json();
      expect(list.meta.total).toBe(1);
    });

    it('returns 400 with an issue array for an invalid config', async () => {
      const res = await post(app, body({ config: { request: { method: 'POST' } } }));
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(json.error.details)).toBe(true);
      expect(json.error.details[0].path).toContain('uri');
    });

    it('returns 400, not 500, for a malformed JSON body', async () => {
      const res = await app.request('/api/v1/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for an unknown componentType and lists what is supported', async () => {
      const res = await post(app, body({ componentType: 'carrier-pigeon' }));
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error.code).toBe('UNKNOWN_COMPONENT_TYPE');
      expect(json.error.details.supported).toEqual(['rest']);
    });
  });

  describe('credential masking', () => {
    const withSecrets = body({
      config: {
        request: {
          uri: 'https://api.example.com/customers',
          method: 'POST',
          auth: { basic: { username: 'svc-account', password: '{$env.CRM_PASSWORD}' } },
        },
      },
    });

    it('masks a {$env.} reference in the POST response', async () => {
      const json = await (await post(app, withSecrets)).json();
      expect(json.data.config.request.auth.basic.password).toBe('****');
      expect(json.data.config.request.auth.basic.username).toBe('svc-account');
    });

    it('masks it on GET one action', async () => {
      await post(app, withSecrets);
      const one = await (await app.request('/api/v1/services/customer-service/create_customer')).json();
      expect(one.data.config.request.auth.basic.password).toBe('****');
    });

    it('masks it on GET by service', async () => {
      await post(app, withSecrets);
      const byService = await (await app.request('/api/v1/services/customer-service')).json();
      expect(byService.data[0].config.request.auth.basic.password).toBe('****');
    });

    it('masks it on GET list', async () => {
      await post(app, withSecrets);
      const list = await (await app.request('/api/v1/services')).json();
      expect(list.data[0].config.request.auth.basic.password).toBe('****');
    });

    it('rejects a re-submitted masked value instead of destroying the reference', async () => {
      await post(app, body({
        config: { request: { uri: 'https://x.test', method: 'POST', auth: { basic: { username: 'u', password: '{$env.CRM_PASSWORD}' } } } },
      }));

      const fetched = await (await app.request('/api/v1/services/customer-service/create_customer')).json();
      expect(fetched.data.config.request.auth.basic.password).toBe('****');

      const res = await post(app, body({ description: 'edited', config: fetched.data.config }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.details[0].path).toEqual(['config', 'request', 'auth', 'basic', 'password']);

      const stored = await db.findComponent('customer-service', 'create_customer');
      expect((stored!.config as any).request.auth.basic.password).toBe('{$env.CRM_PASSWORD}');
    });

    it('returns metaData verbatim, including an $env. string — it is not scanned', async () => {
      const res = await post(app, body({ metaData: { migratedFrom: '$env.LEGACY_URL' } }));
      expect(res.status).toBe(201);
      expect((await res.json()).data.metaData.migratedFrom).toBe('$env.LEGACY_URL');
    });

    it('returns a literal secret verbatim — masking is reference-only', async () => {
      await post(app, body({
        action: 'literal_secret',
        config: {
          request: {
            uri: 'https://x.test', method: 'POST',
            auth: { basic: { username: 'u', password: 'hunter2' } },
          },
        },
      }));

      const json = await (await app.request('/api/v1/services/customer-service/literal_secret')).json();
      expect(json.data.config.request.auth.basic.password).toBe('hunter2');
    });

    it('keeps the real reference in the database — masking is display-only', async () => {
      await post(app, withSecrets);
      const stored = await db.findComponent('customer-service', 'create_customer');
      expect((stored!.config as any).request.auth.basic.password).toBe('{$env.CRM_PASSWORD}');
    });
  });

  describe('GET /api/v1/services (list)', () => {
    const TOTAL_COMPONENTS = 6;

    beforeEach(async () => {
      for (let i = 0; i < 5; i++) await post(app, body({ action: `act_${i}` }));
      await post(app, body({ service: 'other-service', action: 'ping' }));
    });

    it('paginates with real totals, and is not shadowed by /services/:service', async () => {
      const json = await (await app.request('/api/v1/services?limit=2&offset=0')).json();
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.meta).toEqual({ total: TOTAL_COMPONENTS, limit: 2, offset: 0 });
    });

    it('defaults to limit 20, offset 0', async () => {
      const json = await (await app.request('/api/v1/services')).json();
      expect(json.meta.limit).toBe(20);
      expect(json.meta.offset).toBe(0);
    });

    it('clamps limit to 100', async () => {
      const json = await (await app.request('/api/v1/services?limit=5000')).json();
      expect(json.meta.limit).toBe(100);
    });

    it('falls back to the default for garbage paging input', async () => {
      const json = await (await app.request('/api/v1/services?limit=abc&offset=-4')).json();
      expect(json.meta.limit).toBe(20);
      expect(json.meta.offset).toBe(0);
    });

    it('accepts trailing garbage on limit — parseInt stops at the first non-digit', async () => {
      const json = await (await app.request('/api/v1/services?limit=3x')).json();
      expect(json.meta.limit).toBe(3);
    });

    it('paginates without repeating or skipping rows across pages', async () => {
      const first = await (await app.request('/api/v1/services?limit=3&offset=0')).json();
      const second = await (await app.request('/api/v1/services?limit=3&offset=3')).json();
      const keys = [...first.data, ...second.data].map((c: any) => `${c.service}:${c.action}`);
      expect(new Set(keys).size).toBe(TOTAL_COMPONENTS);
    });

    it('filters by service and reflects it in total', async () => {
      const json = await (await app.request('/api/v1/services?service=other-service')).json();
      expect(json.data).toHaveLength(1);
      expect(json.meta.total).toBe(1);
    });

    it('filters by componentType', async () => {
      const json = await (await app.request('/api/v1/services?componentType=rest')).json();
      expect(json.meta.total).toBe(TOTAL_COMPONENTS);
    });
  });

  describe('GET /api/v1/services/:service', () => {
    it('returns every action for the service, unpaginated with empty meta', async () => {
      await post(app, body({ action: 'a' }));
      await post(app, body({ action: 'b' }));

      const json = await (await app.request('/api/v1/services/customer-service')).json();
      expect(json.data).toHaveLength(2);
      expect(json.meta).toEqual({});
    });

    it('returns 200 with an empty array for an unknown service', async () => {
      const res = await app.request('/api/v1/services/ghost-service');
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([]);
    });
  });

  describe('GET /api/v1/services/:service/:action', () => {
    it('returns the component', async () => {
      await post(app, body());
      const json = await (await app.request('/api/v1/services/customer-service/create_customer')).json();
      expect(json.data.action).toBe('create_customer');
      expect(json.meta).toEqual({});
    });

    it('returns 404 with the natural key in the message', async () => {
      const res = await app.request('/api/v1/services/ghost/act');
      expect(res.status).toBe(404);

      const json = await res.json();
      expect(json.error.code).toBe('NOT_FOUND');
      expect(json.error.message).toBe('Service not found: ghost/act');
    });
  });

  describe('DELETE /api/v1/services/:service/:action', () => {
    it('deletes and makes the component unreachable', async () => {
      await post(app, body());

      const res = await app.request('/api/v1/services/customer-service/create_customer', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect((await res.json()).data.deleted).toBe(true);

      const after = await app.request('/api/v1/services/customer-service/create_customer');
      expect(after.status).toBe(404);
    });

    it('returns 200 for a missing component (idempotent)', async () => {
      const res = await app.request('/api/v1/services/ghost/act', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect((await res.json()).data.deleted).toBe(true);
    });
  });

  describe('auth scoping', () => {
    it('protects /api but leaves /health open when API_KEY is set', async () => {
      const secured = createApp({ ...config, apiKey: 'secret-key' }, db).app;

      expect((await secured.request('/health')).status).toBe(200);
      expect((await secured.request('/api/v1/services')).status).toBe(401);

      const authed = await secured.request('/api/v1/services', {
        headers: { Authorization: 'Bearer secret-key' },
      });
      expect(authed.status).toBe(200);
    });
  });
});
