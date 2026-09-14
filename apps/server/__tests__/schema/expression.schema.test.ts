import { describe, it, expect } from 'bun:test';
import {
  RegisterServiceRequestSchema, RestConfigSchema, RateLimitConfigSchema,
} from '@/core/schema/index.js';

const request = { uri: 'https://api.example.com/customer', method: 'POST' };
const registration = { service: 'customer-service', action: 'create', componentType: 'rest', config: { request } };

describe('registration expression validation', () => {
  it('accepts absent conditions and valid conditions without evaluating them', () => {
    expect(RegisterServiceRequestSchema.safeParse(registration).success).toBe(true);
    expect(RegisterServiceRequestSchema.safeParse({
      ...registration, condition: '$.context.missing > 100 && $.context.email exists',
    }).success).toBe(true);
  });

  it.each(['', ' ', '$.context.id &&', '$.context.id =~ "x"', '$.foo.id != null', 'context.id'])(
    'rejects condition %s at the condition field', (condition) => {
      const result = RegisterServiceRequestSchema.safeParse({ ...registration, condition });
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
    expect(RegisterServiceRequestSchema.parse(body)).toEqual(body);
  });

  it('accepts complete response config and optional rule fields', () => {
    expect(RestConfigSchema.safeParse({
      request,
      response: {
        transformation: { result: { id: '$.response.id' } },
        default: { id: 'fallback' },
        validation: { rules: [
          { expression: '$.response.id != null' },
          { expression: '$.response.ok == true', errorPath: '$.response.error.message', message: 'failed' },
        ] },
      },
    }).success).toBe(true);
    expect(RestConfigSchema.safeParse({ request, response: { validation: {} } }).success).toBe(true);
  });

  it.each(['', ' ', '$.response.id &&', '$.response.id =~ "x"', '$.foo.id'])(
    'rejects rule expression %s at its indexed path', (expression) => {
      const result = RestConfigSchema.safeParse({
        request,
        response: { validation: { rules: [{ expression: 'true' }, { expression }] } },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(['response', 'validation', 'rules', 1, 'expression']);
    }
  );

  it.each(['', ' ', '$.response.', '$.response[*]', '$.foo.message', '$.response.id != null'])(
    'rejects errorPath %s at its indexed path, including the empty string', (errorPath) => {
      const result = RestConfigSchema.safeParse({
        request, response: { validation: { rules: [{ expression: 'true', errorPath }] } },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(['response', 'validation', 'rules', 0, 'errorPath']);
    }
  );

  it('reports expression and errorPath errors together', () => {
    const result = RestConfigSchema.safeParse({
      request, response: { validation: { rules: [{ expression: '$.foo', errorPath: '$.bar' }] } },
    });
    expect(result.error?.issues.map((issue) => issue.path.at(-1))).toEqual(['expression', 'errorPath']);
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
