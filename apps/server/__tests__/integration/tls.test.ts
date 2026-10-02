import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { RestComponent } from '@/core/components/rest/rest.component.js';
import * as F from '@fixtures/tls.js';

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

  it('ssl.disableSSL accepts a self-signed server', async () => {
    expect((await call(url(selfSigned), { ssl: { disableSSL: true } })).data).toMatchObject({ ok: true });
    await expect(call(url(selfSigned), { ssl: { disableSSL: false, ca: F.CA_CERT } })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('mTLS: 200 with a client identity, 502 without', async () => {
    const ssl: Ssl = { ca: F.CA_CERT, cert: F.CLIENT_A_CERT, key: F.CLIENT_A_KEY };
    expect((await call(url(mtls), { ssl })).data).toMatchObject({ ok: true });
    await expect(call(url(mtls), { ssl: { ca: F.CA_CERT } })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('mTLS: the client identity actually presented is the one verified (untrusted identity is refused)', async () => {
    const rogue: Ssl = { ca: F.CA_CERT, cert: F.ROGUE_CLIENT_CERT, key: F.ROGUE_CLIENT_KEY };
    await expect(call(url(mtls), { ssl: rogue })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('mTLS: an encrypted key works with its passphrase and fails with a wrong one', async () => {
    const ssl: Ssl = { ca: F.CA_CERT, cert: F.CLIENT_A_CERT, key: F.CLIENT_A_KEY_ENCRYPTED, passphrase: F.CLIENT_A_KEY_PASSPHRASE };
    expect((await call(url(mtls), { ssl })).data).toMatchObject({ ok: true });
    await expect(call(url(mtls), { ssl: { ...ssl, passphrase: 'wrong' } })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('two different client identities work sequentially', async () => {
    for (const [cert, key] of [[F.CLIENT_A_CERT, F.CLIENT_A_KEY], [F.CLIENT_B_CERT, F.CLIENT_B_KEY], [F.CLIENT_A_CERT, F.CLIENT_A_KEY]]) {
      expect((await call(url(mtls), { ssl: { ca: F.CA_CERT, cert, key } })).data).toMatchObject({ ok: true });
    }
  });

  it('invalid material fails with 502, names the field and never echoes it', async () => {
    const error = await call(url(plain), { ssl: { ca: 'SECRET-garbage' } }).catch(e => e);
    expect(error.statusCode).toBe(502);
    expect(error.message).toContain('ssl.ca is not valid');
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
      const invoke = async () => (await api('/tls/get/invoke', 'POST', {})).status;
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

describe('ssl material supplied through {$env.NAME}', () => {
  const setup = async (env: Record<string, string>) => {
    const { createApp } = await import('@/app.js');
    const { createSqliteAdapter } = await import('@/core/db/adapters/sqlite-adapter.js');
    const db = createSqliteAdapter(':memory:');
    await db.connect();
    const { app } = createApp({ port: 0, logLevel: 'silent' }, db, { env });
    const api = (path: string, body: unknown) => app.request(`/api/v1/services${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { db, api };
  };
  const register = async (api: (path: string, body: unknown) => Response | Promise<Response>, uri: string, ssl: unknown) => api('', {
    service: 'tls-env', action: 'get', componentType: 'rest', config: { request: { uri, method: 'GET', ssl } },
  });

  it('resolves ca, cert, key and passphrase from env at invocation (real newlines or escaped \\n)', async () => {
    for (const escaped of [false, true]) {
      const value = (text: string) => (escaped ? text.trim().replace(/\n/g, '\\n') : text);
      const { db, api } = await setup({
        TLS_CA: value(F.CA_CERT), TLS_CERT: value(F.CLIENT_A_CERT),
        TLS_KEY: value(F.CLIENT_A_KEY_ENCRYPTED), TLS_PASS: F.CLIENT_A_KEY_PASSPHRASE,
      });
      try {
        const created = await register(api, url(mtls), {
          ca: ['{$env.TLS_CA}'], cert: '{$env.TLS_CERT}', key: '{$env.TLS_KEY}', passphrase: '{$env.TLS_PASS}',
        });
        expect(created.status).toBe(201);
        expect((await api('/tls-env/get/invoke', {})).status).toBe(200);
      } finally {
        await db.disconnect();
      }
    }
  });

  it('read APIs mask key and passphrase and env refs, and echo inline public certificates', async () => {
    const { db, api } = await setup({});
    try {
      const inline = await (await register(api, url(plain), {
        ca: F.CA_CERT, cert: F.CLIENT_A_CERT, key: F.CLIENT_A_KEY, passphrase: 'inline-pass',
      })).json();
      expect(inline.data.config.request.ssl).toEqual({ ca: F.CA_CERT, cert: F.CLIENT_A_CERT, key: '***', passphrase: '***' });
      const refs = await (await api('', {
        service: 'tls-env', action: 'refs', componentType: 'rest',
        config: { request: { uri: url(plain), method: 'GET', ssl: { ca: '{$env.A}', cert: '{$env.B}', key: '{$env.C}', passphrase: '{$env.D}' } } },
      })).json();
      expect(JSON.stringify(refs.data.config.request.ssl)).not.toContain('$env');
    } finally {
      await db.disconnect();
    }
  });

  it('mixes an inline entry with an env entry in ca', async () => {
    const { db, api } = await setup({ TLS_ROOT: F.CA_CERT });
    try {
      expect((await register(api, url(plain), { ca: [F.SERVER_CERT, '{$env.TLS_ROOT}'] })).status).toBe(201);
      expect((await api('/tls-env/get/invoke', {})).status).toBe(200);
    } finally {
      await db.disconnect();
    }
  });

  it('a missing variable is a 500 ENV_REF_UNRESOLVED and env material without a root is a 502', async () => {
    const missing = await setup({});
    try {
      await register(missing.api, url(plain), { ca: '{$env.TLS_CA}' });
      const res = await missing.api('/tls-env/get/invoke', {});
      expect(res.status).toBe(500);
      expect((await res.json()).error.code).toBe('ENV_REF_UNRESOLVED');
    } finally {
      await missing.db.disconnect();
    }
    const leafOnly = await setup({ TLS_CA: F.SERVER_CERT });
    try {
      await register(leafOnly.api, url(plain), { ca: '{$env.TLS_CA}' });
      expect((await leafOnly.api('/tls-env/get/invoke', {})).status).toBe(502);
    } finally {
      await leafOnly.db.disconnect();
    }
  });
});
