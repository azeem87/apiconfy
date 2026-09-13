import { describe, it, expect } from 'bun:test';
import { RestConfigSchema } from '@/core/schema/index.js';

const minimal = { request: { uri: 'https://api.example.com/customers', method: 'POST' as const } };

describe('RestConfigSchema', () => {
  it('accepts a minimal config', () => {
    expect(RestConfigSchema.safeParse(minimal).success).toBe(true);
  });

  it('requires request.uri and request.method', () => {
    expect(RestConfigSchema.safeParse({ request: { method: 'GET' } }).success).toBe(false);
    expect(RestConfigSchema.safeParse({ request: { uri: 'https://x.test' } }).success).toBe(false);
  });

  it('rejects an unsupported method', () => {
    expect(RestConfigSchema.safeParse({ request: { ...minimal.request, method: 'TRACE' } }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    const result = RestConfigSchema.safeParse({ request: { ...minimal.request, uriTypo: 'x' } });
    expect(result.success).toBe(false);
  });

  it('rejects ssl and disableSSL together', () => {
    const result = RestConfigSchema.safeParse({
      request: {
        ...minimal.request,
        disableSSL: true,
        ssl: { cert: 'PEM', key: 'PEM' },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message).toContain('mutually exclusive');
  });

  it('accepts disableSSL alone — there is no production guard by design', () => {
    expect(RestConfigSchema.safeParse({ request: { ...minimal.request, disableSSL: true } }).success).toBe(true);
  });

  it('accepts exactly one auth strategy', () => {
    const result = RestConfigSchema.safeParse({
      request: {
        ...minimal.request,
        auth: { basic: { username: 'u', password: 'p' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects two auth strategies at once', () => {
    const result = RestConfigSchema.safeParse({
      request: {
        ...minimal.request,
        auth: {
          basic: { username: 'u', password: 'p' },
          oauth2: { clientId: 'c', clientSecret: 's', accessTokenUri: 'https://t.test' },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts no auth block at all', () => {
    expect(RestConfigSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects jwt with both external and local, via the refine and not a field error', () => {
    const result = RestConfigSchema.safeParse({
      request: {
        ...minimal.request,
        auth: {
          jwt: {
            external: {
              username: 'u',
              password: 'p',
              accessTokenUri: 'https://idp.test/token',
            },
            local: { algorithm: 'HS256', secretOrPrivateKey: 'k' },
          },
        },
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues))
      .toContain('exactly one of external or local');
  });

  it('accepts a valid external-only jwt block', () => {
    const result = RestConfigSchema.safeParse({
      request: {
        ...minimal.request,
        auth: {
          jwt: {
            external: { username: 'u', password: 'p', accessTokenUri: 'https://idp.test/token' },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty jwt block', () => {
    const result = RestConfigSchema.safeParse({
      request: { ...minimal.request, auth: { jwt: {} } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues))
      .toContain('exactly one of external or local');
  });

  it('accepts a full resilience block', () => {
    const result = RestConfigSchema.safeParse({
      ...minimal,
      resilience: {
        retryCount: 3, retryDelay: 100, backoff: 'exponential', maxDelay: 5000,
        retryOn: [502, 503],
        circuitBreaker: {
          failureThreshold: 5, windowSize: 60000, openDuration: 30000, halfOpenMaxAttempts: 2,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative timeout', () => {
    expect(RestConfigSchema.safeParse({ ...minimal, timeout: { connect: -1 } }).success).toBe(false);
  });

  it('accepts an $env. reference in a string-typed field', () => {
    const result = RestConfigSchema.safeParse({
      request: {
        ...minimal.request,
        auth: { basic: { username: 'svc', password: '$env.CRM_PASSWORD' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an $env. reference in a number-typed field', () => {
    const result = RestConfigSchema.safeParse({
      ...minimal,
      timeout: { connect: '$env.CRM_TIMEOUT' },
    });
    expect(result.success).toBe(false);
  });
});
