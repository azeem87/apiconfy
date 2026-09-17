import { describe, it, expect } from 'bun:test';
import {
  CreateServiceRequestSchema, RestConfigSchema, RateLimitConfigSchema,
} from '@/core/schema/index.js';

const minimal = { request: { uri: 'https://api.example.com/customers', method: 'POST' as const } };
const request = { uri: 'https://api.example.com/customer', method: 'POST' };
const registration = { service: 'customer-service', action: 'create', componentType: 'rest', config: { request } };

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

  it('rejects retryCount, maxDelay and timeout.response above their caps', () => {
    expect(RestConfigSchema.safeParse({
      ...minimal, resilience: { retryCount: 11 },
    }).success).toBe(false);
    expect(RestConfigSchema.safeParse({
      ...minimal, resilience: { maxDelay: 61_000 },
    }).success).toBe(false);
    expect(RestConfigSchema.safeParse({
      ...minimal, timeout: { response: 120_001 },
    }).success).toBe(false);
  });

  it('accepts retryCount, maxDelay and timeout.response at their caps', () => {
    expect(RestConfigSchema.safeParse({
      ...minimal, resilience: { retryCount: 10, maxDelay: 60_000 },
    }).success).toBe(true);
    expect(RestConfigSchema.safeParse({
      ...minimal, timeout: { response: 120_000 },
    }).success).toBe(true);
  });

  it('accepts a {$env.} reference in a string-typed field', () => {
    const result = RestConfigSchema.safeParse({
      request: {
        ...minimal.request,
        auth: { basic: { username: 'svc', password: '{$env.CRM_PASSWORD}' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a {$env.} reference in a number-typed field', () => {
    const result = RestConfigSchema.safeParse({
      ...minimal,
      timeout: { connect: '{$env.CRM_TIMEOUT}' },
    });
    expect(result.success).toBe(false);
  });
});

describe('registration expression validation', () => {
  it('accepts absent conditions and valid conditions without evaluating them', () => {
    expect(CreateServiceRequestSchema.safeParse(registration).success).toBe(true);
    expect(CreateServiceRequestSchema.safeParse({
      ...registration, condition: '{$context.missing} > 100 && {$context.email} exists',
    }).success).toBe(true);
  });

  it.each(['', ' ', '{$context.id} &&', '{$context.id} =~ "x"', '{$foo.id} != null', 'context.id'])(
    'rejects condition %s at the condition field', (condition) => {
      const result = CreateServiceRequestSchema.safeParse({ ...registration, condition });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(['condition']);
    }
  );

  it('preserves arbitrary config and metadata in the envelope for stage-two validation', () => {
    const body = {
      ...registration,
      config: { custom: 'plugin-owned' },
      metaData: { expression: 'not a predicate', source: '$env.LEGACY_URL' },
    };
    expect(CreateServiceRequestSchema.parse(body)).toEqual(body);
  });

  it('accepts complete output config and optional rule fields', () => {
    expect(RestConfigSchema.safeParse({
      request,
      output: {
        transformation: { result: { id: '{$output.id}' } },
        default: { id: 'fallback' },
        validation: { rules: [
          { expression: '{$output.id} != null' },
          { expression: '{$output.ok} == true', errorPath: '{$output.error.message}', message: 'failed' },
        ] },
      },
    }).success).toBe(true);
    expect(RestConfigSchema.safeParse({ request, output: { validation: {} } }).success).toBe(true);
  });

  it.each(['', ' ', '{$output.id} &&', '{$output.id} =~ "x"', '{$foo.id}'])(
    'rejects rule expression %s at its indexed path', (expression) => {
      const result = RestConfigSchema.safeParse({
        request,
        output: { validation: { rules: [{ expression: 'true' }, { expression }] } },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(['output', 'validation', 'rules', 1, 'expression']);
    }
  );

  it.each(['', ' ', '{$output.}', '{$output[*]}', '{$foo.message}', '{$output.id} != null'])(
    'rejects errorPath %s at its indexed path, including the empty string', (errorPath) => {
      const result = RestConfigSchema.safeParse({
        request, output: { validation: { rules: [{ expression: 'true', errorPath }] } },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(['output', 'validation', 'rules', 0, 'errorPath']);
    }
  );

  it('reports expression and errorPath errors together', () => {
    const result = RestConfigSchema.safeParse({
      request, output: { validation: { rules: [{ expression: '{$foo}', errorPath: '{$bar}' }] } },
    });
    expect(result.error?.issues.map((issue) => issue.path.at(-1))).toEqual(['expression', 'errorPath']);
  });

  describe('OutputConfig validation', () => {
    it('rejects empty output object', () => {
      const result = RestConfigSchema.safeParse({ request, output: {} });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toContain('at least one of');
    });

    it('rejects output with only default (no key/validation/transformation)', () => {
      const result = RestConfigSchema.safeParse({ request, output: { default: { id: 'fallback' } } });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toContain('at least one of');
    });

    it('accepts output with only key', () => {
      expect(RestConfigSchema.safeParse({ request, output: { key: 'fetchUser' } }).success).toBe(true);
    });

    it('accepts output with key + transformation', () => {
      expect(RestConfigSchema.safeParse({
        request, output: { key: 'createCustomer', transformation: { id: '{$output.id}' } },
      }).success).toBe(true);
    });

    it('accepts output with key + validation', () => {
      expect(RestConfigSchema.safeParse({
        request, output: { key: 'getUser', validation: { rules: [{ expression: '{$output.id} != null' }] } },
      }).success).toBe(true);
    });

    it.each(['1abc', 'data-mapper', '_private', 'my-key', 'key.with.dots', 'key with spaces', ''])(
      'rejects output.key %s (invalid pattern)', (key) => {
        const result = RestConfigSchema.safeParse({ request, output: { key, transformation: {} } });
        expect(result.success).toBe(false);
      }
    );

    it.each(['validKey', 'valid_key', 'validKey1', 'a', 'A', 'my_key_123'])(
      'accepts output.key %s (valid pattern)', (key) => {
        expect(RestConfigSchema.safeParse({ request, output: { key } }).success).toBe(true);
      }
    );

    it('rejects old response key (strict mode)', () => {
      const result = RestConfigSchema.safeParse({
        request, response: { transformation: { id: '{$output.id}' } },
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('RateLimitConfigSchema', () => {
  it('accepts positive integer requests/windowMs within existing resilience configuration', () => {
    const rateLimit = { requests: 10, windowMs: 1000 };
    expect(RateLimitConfigSchema.parse(rateLimit)).toEqual(rateLimit);
    expect(RestConfigSchema.safeParse({
      request, resilience: { retryCount: 0, retryDelay: 100, backoff: 'fixed', rateLimit },
    }).success).toBe(true);
  });

  it.each([
    {}, { requests: 10 }, { windowMs: 1000 },
    { requests: 0, windowMs: 1 }, { requests: 1, windowMs: 0 },
    { requests: -1, windowMs: 1 }, { requests: 1, windowMs: -1 },
    { requests: 1.5, windowMs: 1 }, { requests: 1, windowMs: 1.5 },
    { requests: '1', windowMs: 1000 }, { requests: 1, windowMs: '1000' },
    { requests: Infinity, windowMs: 1000 }, { requests: 1, windowMs: NaN },
    { requests: 1, windowMs: 1000, burst: 2 }, null,
  ])('rejects invalid or non-strict rate-limit configuration %#', (rateLimit) => {
    expect(RateLimitConfigSchema.safeParse(rateLimit).success).toBe(false);
    expect(RestConfigSchema.safeParse({ request, resilience: { rateLimit } }).success).toBe(false);
  });
});

describe('template validation', () => {
  it.each([
    ['a malformed uri', { request: { ...request, uri: 'https://api.test/{$ context.id}' } }],
    ['a malformed header value', { request: { ...request, headers: { 'X-Tenant': '{$context.id }' } } }],
    ['a payloadTemplate swallowed by a malformed span', {
      request: { ...request, payloadTemplate: { id: '{$a.b {$context.id}' } },
    }],
    ['an unknown root in transformation', {
      request, output: { transformation: { id: '{$contex.id}' } },
    }],
    ['an unterminated template', { request: { ...request, uri: 'https://api.test/{$context.id' } }],
  ])('rejects %s at registration', (_label, config) => {
    const result = RestConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain('{$');
  });

  it('points the issue at the offending field', () => {
    const result = RestConfigSchema.safeParse({
      request: { ...request, headers: { 'X-Tenant': '{$context.id }' } },
    });
    expect(result.error?.issues[0].path).toEqual(['request', 'headers', 'X-Tenant']);
  });

  it('accepts resolvable templates throughout, including nested arrays', () => {
    expect(RestConfigSchema.safeParse({
      request: {
        ...request,
        uri: 'https://api.test/{$context.id}/{$output.status}?k={$env.API_KEY}',
        headers: { 'X-Tenant': '{$context.tenant}' },
        payloadTemplate: { id: '{$context.id}', deep: { list: ['{$output.id}'] } },
      },
      output: { transformation: { id: '{$output.id}', nested: { at: '{$context.createdAt}' } } },
    }).success).toBe(true);
  });

  it('leaves credential fields alone — a literal {$ in a password is data, not a template', () => {
    expect(RestConfigSchema.safeParse({
      request: {
        ...request,
        auth: { basic: { username: 'svc', password: 'p{$ssword-with-a-brace}' } },
      },
    }).success).toBe(true);
  });
});
