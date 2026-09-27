import type { Logger } from '@/lib/index.js';
import type { ExecutionRecorder, InvocationRecord } from './types.js';
import { AuditWriteError } from '@/core/db/repositories/execution.repository.js';

const DEFAULT_MAX_QUEUE_SIZE = 500;
const DEFAULT_MAX_QUEUE_BYTES = 32 * 1024 * 1024;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [100, 500, 2000];
const BYTE_ALLOWANCE_PER_ENTRY = 256;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cheap size estimate for the payload-carrying fields — walks strings by length instead of
 * serializing, so estimating a multi-MB payload costs a traversal, not a copy.
 */
function estimatePayloadBytes(value: unknown, seen = new Set<object>()): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value !== 'object') return 8;
  if (seen.has(value as object)) return 0;
  seen.add(value as object);
  if (Array.isArray(value)) {
    let total = 16;
    for (const item of value) total += estimatePayloadBytes(item, seen);
    return total;
  }
  let total = 16;
  for (const item of Object.values(value as Record<string, unknown>)) {
    total += estimatePayloadBytes(item, seen);
  }
  return total;
}

function estimateEntryBytes(entry: InvocationRecord): number {
  return BYTE_ALLOWANCE_PER_ENTRY
    + estimatePayloadBytes(entry.context)
    + estimatePayloadBytes(entry.result)
    + estimatePayloadBytes(entry.request)
    + estimatePayloadBytes(entry.response)
    + estimatePayloadBytes(entry.error);
}

/**
 * Decorates an ExecutionRecorder so that `recordInvocation` returns as soon as the entry
 * is queued, instead of waiting for the DB write. A single background pump drains the
 * queue in order on the same event loop (no worker thread, no second connection pool).
 *
 * Durability: transient failures are retried; a failed audit-only write
 * (AuditWriteError) is not retried since the primary execution row is already safe.
 * The queue is bounded by entry count and estimated payload bytes; when either budget is hit
 * (sustained DB outage or an oversized payload) new entries fall back to a single direct
 * write instead of being dropped or blocking the caller for the full retry budget.
 * Call `drain()` before shutdown so nothing queued is lost on a graceful restart.
 */
export class QueuedExecutionRecorder implements ExecutionRecorder {
  private readonly queue: InvocationRecord[] = [];
  private readonly entryBytes = new WeakMap<InvocationRecord, number>();
  private queuedBytes = 0;
  private pumpPromise: Promise<void> | null = null;

  constructor(
    private readonly inner: ExecutionRecorder,
    private readonly logger: Logger,
    private readonly maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    private readonly maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES,
  ) {}

  async recordInvocation(entry: InvocationRecord): Promise<void> {
    const bytes = estimateEntryBytes(entry);
    if (this.queue.length >= this.maxQueueSize || this.queuedBytes + bytes > this.maxQueueBytes) {
      // Sustained backlog (e.g. DB outage) or an oversized payload: apply backpressure rather
      // than drop the entry or exceed the pod's memory budget, but only one attempt — the
      // caller shouldn't pay the full retry budget synchronously.
      this.logger.warn(
        { executionId: entry.executionId, queued: this.queue.length, queuedBytes: this.queuedBytes },
        'Execution log queue full; writing directly',
      );
      await this.writeOnce(entry);
      return;
    }
    this.entryBytes.set(entry, bytes);
    this.queuedBytes += bytes;
    this.queue.push(entry);
    // Starting the pump here, and restarting it from within pump()'s own cleanup (see below)
    // if the queue is non-empty, keeps "queue non-empty implies a pump is running" atomic —
    // there's no `await` between the push and this check, so nothing can interleave.
    this.pumpPromise ??= this.pump();
  }

  /**
   * Waits for every currently-queued entry to be written, up to `timeoutMs`. Call before
   * process shutdown. Never busy-spins: each iteration yields to a real timer, so a stuck
   * write can't starve the event loop.
   */
  async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 || this.pumpPromise !== null) {
      if (Date.now() >= deadline) {
        this.logger.warn(
          { remaining: this.queue.length },
          'Execution log queue drain timed out; remaining records will not be persisted',
        );
        return;
      }
      await Promise.race([this.pumpPromise ?? delay(25), delay(25)]);
    }
  }

  private async pump(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry) continue;
        this.queuedBytes -= this.entryBytes.get(entry) ?? 0;
        await this.writeWithRetry(entry);
      }
    } finally {
      this.pumpPromise = null;
      // An entry can arrive in the gap between the loop's last empty-check and this cleanup
      // running (both are separated by the `await` inside writeWithRetry). Restart immediately
      // instead of leaving it stranded until some later, unrelated call kicks a new pump.
      if (this.queue.length > 0) this.pumpPromise = this.pump();
    }
  }

  private async writeWithRetry(entry: InvocationRecord): Promise<void> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        await this.inner.recordInvocation(entry);
        return;
      } catch (err) {
        if (err instanceof AuditWriteError) {
          this.logAuditOnlyFailure(entry);
          return;
        }
        if (attempt === RETRY_DELAYS_MS.length) {
          this.logDropped(entry);
          return;
        }
        await delay(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  /** Single attempt, used only for the synchronous backpressure fallback. */
  private async writeOnce(entry: InvocationRecord): Promise<void> {
    try {
      await this.inner.recordInvocation(entry);
    } catch (err) {
      if (err instanceof AuditWriteError) {
        this.logAuditOnlyFailure(entry);
        return;
      }
      this.logDropped(entry);
    }
  }

  private logAuditOnlyFailure(entry: InvocationRecord): void {
    this.logger.warn(
      { executionId: entry.executionId },
      'Execution record persisted; audit row could not be written',
    );
  }

  /**
   * Never logs the raw entry or the raw exception: the entry hasn't passed through
   * DbExecutionRepository's redaction, and persistence exceptions must not be logged raw.
   */
  private logDropped(entry: InvocationRecord): void {
    this.logger.error(
      { executionId: entry.executionId, service: entry.service, action: entry.action, status: entry.status },
      'Failed to persist execution record after retries; record dropped',
    );
  }
}
