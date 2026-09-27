import { expect, it } from 'bun:test';
import { createLogger } from '@/lib/logger.js';
import { QueuedExecutionRecorder } from '@/core/runtime/queued-execution-recorder.js';
import { AuditWriteError } from '@/core/db/repositories/execution.repository.js';
import type { ExecutionRecorder, InvocationRecord } from '@/core/runtime/types.js';

function makeEntry(executionId: string): InvocationRecord {
  return {
    executionId, service: 'svc', action: 'act', componentType: 'rest',
    status: 'COMPLETED', logStatus: 'success', context: {}, result: { ok: true },
    attempts: 1, durationMs: 5, startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:00.005Z',
  };
}

function harness() {
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const logger = createLogger('test', 'silent');
  logger.warn = ((...args: unknown[]) => { warnings.push(args); }) as typeof logger.warn;
  logger.error = ((...args: unknown[]) => { errors.push(args); }) as typeof logger.error;
  return { warnings, errors, logger };
}

it('records asynchronously: recordInvocation resolves before the write completes', async () => {
  let writeStarted = false;
  let writeFinished = false;
  const inner: ExecutionRecorder = {
    async recordInvocation() {
      writeStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFinished = true;
    },
  };
  const { logger } = harness();
  const recorder = new QueuedExecutionRecorder(inner, logger);

  await recorder.recordInvocation(makeEntry('a'));
  // recordInvocation returned already, but the underlying write is still in flight.
  expect(writeStarted).toBe(true);
  expect(writeFinished).toBe(false);

  await recorder.drain();
  expect(writeFinished).toBe(true);
});

it('processes queued entries in order via a single pump', async () => {
  const order: string[] = [];
  const inner: ExecutionRecorder = {
    async recordInvocation(entry) {
      await new Promise((resolve) => setTimeout(resolve, entry.executionId === 'a' ? 15 : 0));
      order.push(entry.executionId);
    },
  };
  const { logger } = harness();
  const recorder = new QueuedExecutionRecorder(inner, logger);

  await Promise.all([
    recorder.recordInvocation(makeEntry('a')),
    recorder.recordInvocation(makeEntry('b')),
    recorder.recordInvocation(makeEntry('c')),
  ]);
  await recorder.drain();

  expect(order).toEqual(['a', 'b', 'c']);
});

it('retries a transient write failure and eventually succeeds without logging an error', async () => {
  let attempts = 0;
  const inner: ExecutionRecorder = {
    async recordInvocation() {
      attempts++;
      if (attempts < 3) throw new Error('connection reset');
    },
  };
  const { logger, errors } = harness();
  const recorder = new QueuedExecutionRecorder(inner, logger);

  await recorder.recordInvocation(makeEntry('retry-me'));
  await recorder.drain();

  expect(attempts).toBe(3);
  expect(errors).toHaveLength(0);
});

it('does not retry an AuditWriteError — the primary row is already safe', async () => {
  let attempts = 0;
  const inner: ExecutionRecorder = {
    async recordInvocation() {
      attempts++;
      throw new AuditWriteError(new Error('audit table missing'));
    },
  };
  const { logger, warnings, errors } = harness();
  const recorder = new QueuedExecutionRecorder(inner, logger);

  await recorder.recordInvocation(makeEntry('audit-fail'));
  await recorder.drain();

  expect(attempts).toBe(1);
  expect(warnings.some(([, msg]) => String(msg).includes('audit row could not be written'))).toBe(true);
  expect(errors).toHaveLength(0);
});

it('logs a redacted summary, never the raw entry or exception, once retries are exhausted', async () => {
  const inner: ExecutionRecorder = {
    async recordInvocation() {
      throw new Error('SECRET-CONNECTION-STRING should never be logged');
    },
  };
  const { logger, errors } = harness();
  const recorder = new QueuedExecutionRecorder(inner, logger);

  await recorder.recordInvocation(makeEntry('unrecoverable'));
  await recorder.drain();

  expect(errors).toHaveLength(1);
  const [payload] = errors[0] as [Record<string, unknown>, string];
  expect(payload).toEqual({ executionId: 'unrecoverable', service: 'svc', action: 'act', status: 'COMPLETED' });
  expect(JSON.stringify(payload)).not.toContain('SECRET-CONNECTION-STRING');
});

it('falls back to a single direct write under backpressure instead of dropping the entry', async () => {
  let attempts = 0;
  const inner: ExecutionRecorder = {
    async recordInvocation() {
      attempts++;
      throw new Error('db unavailable');
    },
  };
  const { logger, warnings, errors } = harness();
  // maxQueueSize = 0 forces every call straight down the backpressure path.
  const recorder = new QueuedExecutionRecorder(inner, logger, 0);

  const start = Date.now();
  await recorder.recordInvocation(makeEntry('overflow'));
  const elapsedMs = Date.now() - start;

  // Exactly one attempt — no multi-second retry budget spent on the caller.
  expect(attempts).toBe(1);
  expect(elapsedMs).toBeLessThan(50);
  expect(warnings.some(([, msg]) => String(msg).includes('queue full'))).toBe(true);
  expect(errors).toHaveLength(1);
});

it('falls back to a direct write when the byte budget is exceeded, and releases bytes after draining', async () => {
  const written: string[] = [];
  const inner: ExecutionRecorder = { async recordInvocation(entry) { written.push(entry.executionId); } };
  const { logger, warnings } = harness();
  const recorder = new QueuedExecutionRecorder(inner, logger, 500, 4096);

  const big = makeEntry('big');
  big.response = 'x'.repeat(10_000);
  await recorder.recordInvocation(big);
  expect(written).toEqual(['big']);
  expect(warnings).toHaveLength(1);

  await recorder.recordInvocation(makeEntry('small'));
  await recorder.drain();
  expect(written).toEqual(['big', 'small']);
  expect((recorder as unknown as { queuedBytes: number }).queuedBytes).toBe(0);
});

it('drain() resolves once every queued entry is written, even under concurrent enqueues', async () => {
  let written = 0;
  const inner: ExecutionRecorder = {
    async recordInvocation() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      written++;
    },
  };
  const { logger } = harness();
  const recorder = new QueuedExecutionRecorder(inner, logger);

  const fires = Array.from({ length: 25 }, (_, i) => i);
  await Promise.all(fires.map((i) => new Promise<void>((resolve) => {
    setTimeout(() => { void recorder.recordInvocation(makeEntry(`e${i}`)).then(resolve); }, i % 3);
  })));
  await recorder.drain();

  expect(written).toBe(25);
});

it('drain() never hangs and honors its timeout even if the pump/queue invariant is violated', async () => {
  const inner: ExecutionRecorder = { async recordInvocation() {} };
  const { logger, warnings } = harness();
  const recorder = new QueuedExecutionRecorder(inner, logger) as unknown as {
    queue: InvocationRecord[]; pumpPromise: Promise<void> | null; drain(timeoutMs?: number): Promise<void>;
  };
  // Force the exact invariant-violation state the pump/finally logic is designed to prevent:
  // an entry sitting in the queue with no pump running to pick it up.
  recorder.queue.push(makeEntry('forced-stranded'));
  recorder.pumpPromise = null;

  const start = Date.now();
  await recorder.drain(200);
  const elapsedMs = Date.now() - start;

  expect(elapsedMs).toBeGreaterThanOrEqual(190);
  expect(elapsedMs).toBeLessThan(1000);
  expect(warnings.some(([, msg]) => String(msg).includes('drain timed out'))).toBe(true);
});
