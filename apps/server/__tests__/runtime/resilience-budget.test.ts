import { describe, expect, it } from 'bun:test';
import { DefaultResilienceExecutor } from '@/core/runtime/resilience-executor.js';
import { ConnectionError, TimeoutError } from '@/lib/errors.js';

const noSleep = (): Promise<void> => Promise.resolve();

describe('resilience maxElapsedTime', () => {
  it('stops retrying when the next delay would exceed the budget', async () => {
    let calls = 0;
    const executor = new DefaultResilienceExecutor(noSleep);
    await expect(executor.execute(async () => {
      calls += 1;
      throw new ConnectionError('down');
    }, { resilience: { retryCount: 5, retryDelay: 1000, maxElapsedTime: 500 } })).rejects.toBeInstanceOf(ConnectionError);
    expect(calls).toBe(1);
  });

  it('caps an attempt at the remaining budget', async () => {
    const executor = new DefaultResilienceExecutor(noSleep);
    const started = Date.now();
    await expect(executor.execute(
      () => new Promise<never>(() => {}),
      { timeout: { requestTimeout: 5000 }, resilience: { retryCount: 3, retryDelay: 1, maxElapsedTime: 100 } },
    )).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps retrying within the budget', async () => {
    let calls = 0;
    const executor = new DefaultResilienceExecutor(noSleep);
    const result = await executor.execute(async () => {
      calls += 1;
      if (calls < 3) throw new ConnectionError('down');
      return 'ok';
    }, { resilience: { retryCount: 5, retryDelay: 1, maxElapsedTime: 5000 } });
    expect(result).toEqual({ value: 'ok', attempts: 3 });
  });
});

describe('requestTimeout: 0 (unbounded)', () => {
  it('does not cap an attempt', async () => {
    const executor = new DefaultResilienceExecutor();
    const result = await executor.execute(
      () => new Promise<string>(resolve => setTimeout(() => resolve('ok'), 50)),
      { timeout: { requestTimeout: 0 }, resilience: {} }
    );
    expect(result.value).toBe('ok');
  });

  it('maxElapsedTime still bounds the call', async () => {
    const executor = new DefaultResilienceExecutor();
    const started = Date.now();
    await expect(executor.execute(
      () => new Promise<string>(() => {}),
      { timeout: { requestTimeout: 0 }, resilience: { maxElapsedTime: 100 } }
    )).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
