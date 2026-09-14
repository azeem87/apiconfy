import { expect, it } from 'bun:test';
import { DefaultResilienceExecutor } from '@/core/runtime/resilience-executor.js';
import { InMemoryTokenBucketRateLimiter } from '@/core/runtime/rate-limiter.js';
import { ComponentHandlerRegistry } from '@/core/runtime/component-handler-registry.js';
import { injectStandardError, runResponsePipeline, transformResponse } from '@/core/runtime/response-pipeline.js';
import { ExternalServiceError, TimeoutError, ResponseValidationError } from '@/lib/errors.js';

it('retries configured 5xx with capped backoff, never configured 4xx', async () => {
  const delays: number[] = [];
  const executor = new DefaultResilienceExecutor(async delay => { delays.push(delay); });
  let attempts = 0;
  const result = await executor.execute(async () => {
    attempts += 1;
    if (attempts < 4) throw new ExternalServiceError('unavailable', 503, { downstream: { status: 503 } });
    return 'ok';
  }, { resilience: { retryCount: 3, retryDelay: 10, backoff: 'exponential', maxDelay: 25 } });
  expect(result).toEqual({ value: 'ok', attempts: 4 });
  expect(delays).toEqual([10, 20, 25]);
  attempts = 0;
  await expect(executor.execute(async () => {
    attempts += 1;
    throw new ExternalServiceError('bad', 429, { downstream: { status: 429 } });
  }, { resilience: { retryCount: 3, retryOn: [429] } })).rejects.toThrow(ExternalServiceError);
  expect(attempts).toBe(1);
});

it('bounds even a non-cooperative handler and aborts its signal', async () => {
  let signal: AbortSignal | undefined;
  await expect(new DefaultResilienceExecutor().execute(async supplied => {
    signal = supplied;
    return new Promise(() => {});
  }, { timeout: { response: 5 } })).rejects.toThrow(TimeoutError);
  expect(signal?.aborted).toBe(true);
});

it('uses fractional lazy refill with independent buckets, no clock rollback minting', async () => {
  let now = 0;
  const limiter = new InMemoryTokenBucketRateLimiter(() => now);
  const config = { requests: 2, windowMs: 1000 };
  expect((await limiter.consume('a', config)).remaining).toBe(1);
  expect((await limiter.consume('a', config)).remaining).toBe(0);
  expect(await limiter.consume('a', config)).toMatchObject({ allowed: false, resetTimeMs: 500 });
  now = 499;
  expect((await limiter.consume('a', config)).allowed).toBe(false);
  now = 500;
  expect((await limiter.consume('a', config)).allowed).toBe(true);
  now = -100;
  expect((await limiter.consume('a', config)).allowed).toBe(false);
  expect((await limiter.consume('b', config)).allowed).toBe(true);
  expect((await limiter.consume('a', { requests: 5, windowMs: 1000 })).remaining).toBe(4);
});

it('validates before default but permits failure transformation and error overwrite', () => {
  const config = { response: {
    validation: { rules: [{ expression: '$.response.id != null', errorPath: '$.response.message' }] },
    default: { id: 3 },
    transformation: { out: { id: '$.response.id' } },
  } };
  const bag = { context: {}, response: { id: null, message: 'missing' } };
  expect(() => runResponsePipeline(config, bag)).toThrow(ResponseValidationError);
  expect(transformResponse(config, bag)).toEqual({ out: { id: null } });
  expect(injectStandardError({ error: { wrong: true } }, { error: { code: 'X', message: 'bad' } }))
    .toEqual({ error: { code: 'X', message: 'bad' } });
  for (const response of [null, undefined, '']) {
    expect(runResponsePipeline({ response: { default: { id: 3 } } }, { context: {}, response })).toEqual({ id: 3 });
  }
  for (const response of [false, 0, {}, []]) {
    expect(runResponsePipeline({ response: { default: { id: 3 } } }, { context: {}, response })).toEqual(response);
  }
});

it('registries are independent and sorted, last registration wins', () => {
  const registry = new ComponentHandlerRegistry();
  const handler = { componentType: 'test', displayName: 'Test', async execute() { return { statusCode: 200, data: null }; } };
  expect(registry.register(handler)).toBe(registry);
  expect(registry.get('test')).toBe(handler);
  expect(registry.has('test')).toBe(true);
  expect(registry.registeredTypes()).toEqual(['test']);
  expect(new ComponentHandlerRegistry().has('test')).toBe(false);
});
