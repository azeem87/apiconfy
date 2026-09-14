import { expect, it } from 'bun:test';
import { createLogger } from '@/lib/logger.js';
import { DefaultRuntimeExecutor } from '@/core/runtime/runtime-executor.js';
import { DefaultResilienceExecutor } from '@/core/runtime/resilience-executor.js';
import { InMemoryTokenBucketRateLimiter } from '@/core/runtime/rate-limiter.js';
import { ComponentHandlerRegistry } from '@/core/runtime/component-handler-registry.js';
import type { ComponentHandler } from '@/core/components/base.js';
import type { ComponentRecord } from '@/core/db/adapter.js';
import type { InvocationRecord } from '@/core/runtime/types.js';
import { AppError, ConnectionError } from '@/lib/errors.js';

function harness(handler: ComponentHandler, config: Record<string, unknown> = {}) {
  const entries: InvocationRecord[] = [];
  const logs: unknown[] = [];
  const logger = createLogger('test', 'silent');
  logger.warn = ((...args: unknown[]) => { logs.push(args); }) as typeof logger.warn;
  const row: ComponentRecord = {
    id: 'component', service: 'svc', action: 'act', componentType: handler.componentType,
    config, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  };
  const recorder = { async recordInvocation(entry: InvocationRecord) { entries.push(entry); } };
  const executor = new DefaultRuntimeExecutor({
    lookup: { async findByKey() { return row; } },
    handlers: new ComponentHandlerRegistry().register(handler),
    resilience: new DefaultResilienceExecutor(async () => {}),
    rateLimiter: new InMemoryTokenBucketRateLimiter(), recorder, logger, env: { SHORT: 'e' },
  });
  const invoke = () => executor.invoke({
    service: 'svc', action: 'act', context: { id: 1 }, executionId: 'x', startedAtMs: Date.now(),
  });
  return { entries, logs, recorder, invoke };
}

it('persistence failure cannot change the result or expose raw DB errors in logs', async () => {
  const state = harness({
    componentType: 'test', displayName: 'Test',
    async execute() { return { statusCode: 200, data: { id: 1 } }; },
  });
  state.recorder.recordInvocation = async () => { throw new Error('SQL with password=private'); };
  expect((await state.invoke()).data).toEqual({ id: 1 });
  expect(JSON.stringify(state.logs)).not.toContain('private');
  expect(JSON.stringify(state.logs)).toContain('Failed to persist');
});

it('keeps original failure after exhausted retries even when recording fails', async () => {
  const state = harness({
    componentType: 'test', displayName: 'Test',
    async execute() { throw new ConnectionError('unavailable'); },
  }, { resilience: { retryCount: 2 } });
  await expect(state.invoke()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
  expect(state.entries[0].attempts).toBe(3);
  expect(state.entries).toHaveLength(1);
  state.recorder.recordInvocation = async () => { throw new Error('private'); };
  await expect(state.invoke()).rejects.toMatchObject({ code: 'CONNECTION_ERROR' });
});

it('failed transformations are observable but never replace the primary error', async () => {
  const transformation = Object.defineProperty({}, 'bad', {
    enumerable: true, get() { throw new Error('private getter failure'); },
  });
  const state = harness({
    componentType: 'test', displayName: 'Test',
    assertExecutable() { throw new AppError('primary', 'PRIMARY'); },
    async execute() { throw new Error('unreachable'); },
  }, { response: { transformation } });
  await expect(state.invoke()).rejects.toMatchObject({ code: 'PRIMARY' });
  expect(state.entries).toHaveLength(1);
  expect(state.entries[0].result).toEqual({ error: { code: 'PRIMARY', message: 'primary' } });
  expect(JSON.stringify(state.logs)).toContain('Failure response transformation failed');
  expect(JSON.stringify(state.logs)).not.toContain('private');
});

it('single-character secrets do not corrupt standardized error keys', async () => {
  const state = harness({
    componentType: 'test', displayName: 'Test',
    async execute() { throw new ConnectionError('e'); },
  }, { credential: '$env.SHORT' });
  await expect(state.invoke()).rejects.toMatchObject({ code: 'CONNECTION_ERROR', message: '***' });
  expect(state.entries[0].result).toEqual({ error: { code: 'CONNECTION_ERROR', message: '***' } });
});
