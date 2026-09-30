import { describe, it, expect } from 'bun:test';
import { CA_CERT, CA_CERT_DER_BASE64, SERVER_CERT } from '../fixtures/tls.js';
import {
  CreateServiceRequestSchema, RestConfigSchema,
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
        ssl: { ca: CA_CERT },
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

describe('payload validation fields (request.validation)', () => {
  const withValidation = (fields: unknown[]) => ({
    request: { ...request, validation: { fields } },
  });

  it('accepts a full validation block including quoted paths and wildcards', () => {
    expect(RestConfigSchema.safeParse(withValidation([
      { path: 'userId', required: true, type: 'string' },
      { path: 'customer.email', required: true, type: 'string', minLength: 1 },
      { path: 'items', required: true, type: 'array', minItems: 1, message: 'items must contain at least one entry' },
      { path: 'items[*].sku', required: true, type: 'string' },
      { path: 'meta["external-id"]', type: 'string' },
    ])).success).toBe(true);
  });

  it('rejects empty field lists and entries without constraints', () => {
    expect(RestConfigSchema.safeParse(withValidation([])).success).toBe(false);
    expect(RestConfigSchema.safeParse(withValidation([{ path: 'userId', message: 'only a message' }])).success).toBe(false);
  });

  it('rejects {$context.} entries with a pointed message', () => {
    const result = RestConfigSchema.safeParse(withValidation([{ path: '{$context.userId}', required: true }]));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain('write the payload field path directly — "userId"');
    expect(result.error?.issues[0].path).toEqual(['request', 'validation', 'fields', 0, 'path']);
  });

  it('rejects runtime namespace prefixes but allows the quoted literal form', () => {
    const rejected = RestConfigSchema.safeParse(withValidation([{ path: 'context.userId', required: true }]));
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues[0].message).toContain('runtime namespace');
    expect(RestConfigSchema.safeParse(withValidation([{ path: '["context"].userId', required: true }])).success).toBe(true);
  });

  it('rejects malformed paths and unknown keys', () => {
    expect(RestConfigSchema.safeParse(withValidation([{ path: 'a..b', required: true }])).success).toBe(false);
    expect(RestConfigSchema.safeParse(withValidation([{ path: 'userId', required: true, minLength: 1 }])).success).toBe(false);
  });

  it('couples minItems to array and minLength to string', () => {
    expect(RestConfigSchema.safeParse(withValidation([{ path: 'items', minItems: 1 }])).success).toBe(false);
    expect(RestConfigSchema.safeParse(withValidation([{ path: 'text', type: 'string', minItems: 1 }])).success).toBe(false);
    expect(RestConfigSchema.safeParse(withValidation([{ path: 'text', minLength: 1 }])).success).toBe(false);
    expect(RestConfigSchema.safeParse(withValidation([{ path: 'text', type: 'number', minLength: 1 }])).success).toBe(false);
  });
});

describe('RestConfigSchema request.ssl', () => {
  const ssl = (value: unknown) => RestConfigSchema.safeParse({ request: { ...minimal.request, ssl: value } });
  const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
  const key = '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----';

  it('accepts ca alone, cert+key and DER literal', () => {
    expect(ssl({ ca: CA_CERT }).success).toBe(true);
    expect(ssl({ cert, key, passphrase: 'x' }).success).toBe(true);
    expect(ssl({ ca: CA_CERT_DER_BASE64 }).success).toBe(true);
    expect(ssl({ ca: `${SERVER_CERT}${CA_CERT}` }).success).toBe(true);
  });

  it('rejects empty ssl, half identities and orphan passphrase', () => {
    expect(ssl({}).success).toBe(false);
    expect(ssl({ cert }).success).toBe(false);
    expect(ssl({ key }).success).toBe(false);
    expect(ssl({ ca: CA_CERT, passphrase: 'x' }).success).toBe(false);
  });

  it('rejects env refs — ssl material is inline only', () => {
    expect(ssl({ ca: '{$env.CA}' }).success).toBe(false);
  });

  it('accepts ca as a list, one entry per certificate file (PEM or base64 DER)', () => {
    expect(ssl({ ca: [SERVER_CERT, CA_CERT_DER_BASE64] }).success).toBe(true);
    expect(ssl({ ca: [SERVER_CERT] }).success).toBe(false);
    expect(ssl({ ca: [] }).success).toBe(false);
    expect(ssl({ ca: [CA_CERT, 'garbage'] }).success).toBe(false);
  });

  it('supports ssl.disableSSL, alone or with a client identity, but not with ca', () => {
    expect(ssl({ disableSSL: true }).success).toBe(true);
    expect(ssl({ disableSSL: true, cert, key }).success).toBe(true);
    expect(ssl({ disableSSL: false, ca: CA_CERT }).success).toBe(true);
    expect(ssl({ disableSSL: false }).success).toBe(false);
    expect(ssl({ disableSSL: true, ca: CA_CERT }).success).toBe(false);
    expect(ssl({ disableSSL: 'yes' }).success).toBe(false);
  });

  it('rejects a ca without a self-signed root (lone leaf) with guidance', () => {
    const result = ssl({ ca: SERVER_CERT });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('root CA certificate');
  });

  it('rejects malformed literals with guidance', () => {
    expect(ssl({ ca: 'not a cert' }).success).toBe(false);
    const result = ssl({ cert, key: 'not a key' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('PEM private key');
  });
});
