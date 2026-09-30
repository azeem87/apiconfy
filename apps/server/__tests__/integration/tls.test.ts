import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { RestComponent } from '@/core/components/rest/rest.component.js';
import * as F from '../fixtures/tls.js';

type Ssl = Record<string, string>;
let plain: ReturnType<typeof Bun.serve>;
let selfSigned: ReturnType<typeof Bun.serve>;
let mtls: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  const handler = (req: Request, server: { requestIP: unknown }) => Response.json({ ok: true, path: new URL(req.url).pathname, server: !!server });
  selfSigned = Bun.serve({
    hostname: '127.0.0.1', port: 0, tls: { cert: F.SELF_SIGNED_CERT, key: F.SELF_SIGNED_KEY },
    fetch: req => handler(req, {} as never),
  });
  plain = Bun.serve({
    hostname: '127.0.0.1', port: 0, tls: { cert: F.SERVER_CERT, key: F.SERVER_KEY },
    fetch: req => handler(req, {} as never),
  });
  mtls = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    tls: { cert: F.SERVER_CERT, key: F.SERVER_KEY, ca: F.CA_CERT, requestCert: true, rejectUnauthorized: true },
    fetch: req => handler(req, {} as never),
  });
});
afterAll(() => { selfSigned.stop(true); plain.stop(true); mtls.stop(true); });

const call = (uri: string, request: Record<string, unknown> = {}) => new RestComponent().execute({
  config: { request: { uri, method: 'GET', ...request } },
  context: { context: {}, env: {}, output: null } as never,
  signal: new AbortController().signal,
  executionId: 'exec-1',
});
const url = (server: { port?: number }) => `https://localhost:${server.port}/x`;

describe('REST TLS (real handshakes)', () => {
  it('rejects an untrusted server with 502 CONNECTION_ERROR', async () => {
    await expect(call(url(selfSigned))).rejects.toMatchObject({ statusCode: 502 });
  });

  it('trusts a server through ca (PEM and base64 DER)', async () => {
    expect((await call(url(plain), { ssl: { ca: F.CA_CERT } })).data).toMatchObject({ ok: true });
    expect((await call(url(plain), { ssl: { ca: F.CA_CERT_DER_BASE64 } })).data).toMatchObject({ ok: true });
    expect((await call(url(selfSigned), { ssl: { ca: F.SELF_SIGNED_CERT } })).data).toMatchObject({ ok: true });
    const mixed = `${F.SERVER_CERT}\n${F.CA_CERT_DER_BASE64}\n`;
    expect((await call(url(plain), { ssl: { ca: mixed } })).data).toMatchObject({ ok: true });
    expect((await call(url(plain), { ssl: { ca: [F.SERVER_CERT, F.CA_CERT_DER_BASE64] } })).data).toMatchObject({ ok: true });
  });

  it('accepts a self-signed server with disableSSL', async () => {
    expect((await call(url(selfSigned), { disableSSL: true })).data).toMatchObject({ ok: true });
  });

  it('ssl.disableSSL accepts a self-signed server, alone or with a client identity', async () => {
    expect((await call(url(selfSigned), { ssl: { disableSSL: true } })).data).toMatchObject({ ok: true });
    const identity = { cert: F.CLIENT_A_CERT, key: F.CLIENT_A_KEY };
    expect((await call(url(mtls), { ssl: { disableSSL: true, ...identity } })).data).toMatchObject({ ok: true });
    await expect(call(url(selfSigned), { ssl: { disableSSL: false } })).rejects.toBeDefined();
  });

  it('mTLS: 200 with a client identity, 502 without', async () => {
    const ssl: Ssl = { ca: F.CA_CERT, cert: F.CLIENT_A_CERT, key: F.CLIENT_A_KEY };
    expect((await call(url(mtls), { ssl })).data).toMatchObject({ ok: true });
    await expect(call(url(mtls), { ssl: { ca: F.CA_CERT } })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('two different client identities work sequentially', async () => {
    for (const [cert, key] of [[F.CLIENT_A_CERT, F.CLIENT_A_KEY], [F.CLIENT_B_CERT, F.CLIENT_B_KEY], [F.CLIENT_A_CERT, F.CLIENT_A_KEY]]) {
      expect((await call(url(mtls), { ssl: { ca: F.CA_CERT, cert, key } })).data).toMatchObject({ ok: true });
    }
  });

  it('invalid material fails with 502 and never echoes it', async () => {
    const error = await call(url(plain), { ssl: { ca: 'SECRET-garbage' } }).catch(e => e);
    expect(error.statusCode).toBe(502);
    expect(error.message).not.toContain('SECRET-garbage');
  });

  it('passes exact tls options through an injected fetch', async () => {
    let seen: Record<string, unknown> | undefined;
    const fake = (async (_u: unknown, init: { tls?: Record<string, unknown> }) => {
      seen = init.tls;
      return Response.json({});
    }) as unknown as typeof fetch;
    const run = (request: Record<string, unknown>) => new RestComponent(fake).execute({
      config: { request: { uri: 'https://x.test', method: 'GET', ...request } },
      context: { context: {}, env: {}, output: null } as never,
      signal: new AbortController().signal, executionId: 'e',
    });
    await run({});
    expect(seen).toBeUndefined();
    await run({ disableSSL: false });
    expect(seen).toBeUndefined();
    await run({ disableSSL: true });
    expect(seen).toEqual({ rejectUnauthorized: false });
    await run({ ssl: { disableSSL: true } });
    expect(seen).toEqual({ rejectUnauthorized: false });
    await run({ ssl: { disableSSL: false, ca: F.CA_CERT } });
    expect(seen).toEqual({ ca: F.CA_CERT.trim() + '\n' });
    await run({ ssl: { ca: F.CA_CERT_DER_BASE64, cert: F.CLIENT_A_CERT, key: F.CLIENT_A_KEY, passphrase: 'p' } });
    expect(seen).toEqual({
      ca: F.CA_CERT.trim() + '\n', cert: F.CLIENT_A_CERT.trim() + '\n', key: F.CLIENT_A_KEY.trim() + '\n', passphrase: 'p',
    });
  });
});

describe('ssl config is read at invoke time', () => {
  it('a config change takes effect on the next invocation without a restart', async () => {
    const { createApp } = await import('@/app.js');
    const { createSqliteAdapter } = await import('@/core/db/adapters/sqlite-adapter.js');
    const db = createSqliteAdapter(':memory:');
    await db.connect();
    const { app } = createApp({ port: 0, logLevel: 'silent' }, db);
    const api = (path: string, method: string, body?: unknown) => app.request(`/api/v1/services${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const config = (ssl: unknown) => ({ request: { uri: url(plain), method: 'GET', ssl } });
    try {
      const created = await (await api('', 'POST', {
        service: 'tls', action: 'get', componentType: 'rest', config: config({ ca: [F.CA_CERT] }),
      })).json();
      let version = created.data.version as number;
      const invoke = async () => (await api('/tls/get/invoke', 'POST', { context: {} })).status;
      const update = async (ssl: unknown) => {
        const res = await api('/tls/actions/get', 'PUT', { componentType: 'rest', config: config(ssl), version });
        expect(res.status).toBe(200);
        version = (await res.json()).data.version;
      };

      expect(await invoke()).toBe(200);
      await update({ ca: [F.SELF_SIGNED_CERT] });
      expect(await invoke()).toBe(502);
      await update({ ca: [F.CA_CERT] });
      expect(await invoke()).toBe(200);
    } finally {
      await db.disconnect();
    }
  });
});
