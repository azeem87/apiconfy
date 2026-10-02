import { describe, expect, it } from 'bun:test';
import { RestComponent } from '@/core/components/rest/rest.component.js';

interface Call { url: string; headers: Headers; body: string }

function setup(apiStatuses: number[] = [200]) {
  const tokenCalls: Call[] = [];
  const apiCalls: Call[] = [];
  let issued = 0;
  const fake = (async (url: string, init: { headers: Headers; body?: string }) => {
    const call = { url, headers: new Headers(init.headers), body: init.body ?? '' };
    if (url.includes('/token')) {
      tokenCalls.push(call);
      issued += 1;
      return Response.json({ access_token: `tok-${issued}`, token_type: 'Bearer' });
    }
    apiCalls.push(call);
    return Response.json({ ok: true }, { status: apiStatuses[apiCalls.length - 1] ?? 200 });
  }) as unknown as typeof fetch;
  const component = new RestComponent(fake);
  const oauth2 = {
    clientId: 'id', clientSecret: 's:ecret', accessTokenUri: 'https://idp.test/token', scope: 'read write',
  };
  const run = (auth: unknown, secrets: string[] = []) => component.execute({
    config: { request: { uri: 'https://api.test/x', method: 'GET', auth } },
    context: { context: {}, env: {}, output: null } as never,
    signal: new AbortController().signal, executionId: 'e', onSecret: secret => secrets.push(secret),
  });
  return { run, oauth2, tokenCalls, apiCalls };
}

describe('REST auth runtime', () => {
  it('fetches a client_credentials token with Basic client auth and sends it as a Bearer header', async () => {
    const { run, oauth2, tokenCalls, apiCalls } = setup();
    const secrets: string[] = [];
    await run({ oauth2 }, secrets);
    const form = new URLSearchParams(tokenCalls[0].body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('read write');
    expect(form.has('client_secret')).toBe(false);
    expect(tokenCalls[0].headers.get('authorization')).toBe(`Basic ${Buffer.from('id:s%3Aecret').toString('base64')}`);
    expect(tokenCalls[0].headers.get('accept')).toBe('application/json');
    expect(apiCalls[0].headers.get('authorization')).toBe('Bearer tok-1');
    expect(secrets).toContain('tok-1');
  });

  it('puts the client credentials in the body for clientAuth "body"', async () => {
    const { run, oauth2, tokenCalls } = setup();
    await run({ oauth2: { ...oauth2, clientAuth: 'body', audience: 'api://x' } });
    const form = new URLSearchParams(tokenCalls[0].body);
    expect(form.get('client_id')).toBe('id');
    expect(form.get('client_secret')).toBe('s:ecret');
    expect(form.get('audience')).toBe('api://x');
    expect(tokenCalls[0].headers.has('authorization')).toBe(false);
  });

  it('caches the token across calls', async () => {
    const { run, oauth2, tokenCalls, apiCalls } = setup();
    await run({ oauth2 });
    await run({ oauth2 });
    expect(tokenCalls).toHaveLength(1);
    expect(apiCalls.map(call => call.headers.get('authorization'))).toEqual(['Bearer tok-1', 'Bearer tok-1']);
  });

  it('shares one token request between concurrent first calls', async () => {
    const { run, oauth2, tokenCalls } = setup();
    await Promise.all([run({ oauth2 }), run({ oauth2 }), run({ oauth2 })]);
    expect(tokenCalls).toHaveLength(1);
  });

  it('invalidates the cached token on a 401 and replays once with a fresh one', async () => {
    const { run, oauth2, tokenCalls, apiCalls } = setup([401, 200]);
    const result = await run({ oauth2 });
    expect(result.data).toEqual({ ok: true });
    expect(tokenCalls).toHaveLength(2);
    expect(apiCalls.map(call => call.headers.get('authorization'))).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('does not replay a second 401', async () => {
    const { run, oauth2, apiCalls } = setup([401, 401, 200]);
    await expect(run({ oauth2 })).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' });
    expect(apiCalls).toHaveLength(2);
  });

  it('sends a static Basic header for the basic block, with no replay', async () => {
    const { run, tokenCalls, apiCalls } = setup([401]);
    await expect(run({ basic: { username: 'u', password: 'p' } })).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' });
    expect(tokenCalls).toHaveLength(0);
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].headers.get('authorization')).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('still refuses the jwt blocks until they are implemented', () => {
    expect(() => new RestComponent().assertExecutable({
      request: { uri: 'https://x.test', method: 'GET', auth: { jwt: { local: {} } } },
    })).toThrow(/auth\.jwt/);
    expect(() => new RestComponent().assertExecutable({
      request: { uri: 'https://x.test', method: 'GET', auth: { oauth2: {} } },
    })).not.toThrow();
  });
});
