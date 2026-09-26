import type { DBAdapter, ExecutionLogRecord, ExecutionRecord } from '@/core/db/adapter.js';
import type { InvocationRecord } from '@/core/runtime/types.js';
import { generateId, redactSensitiveFields } from '@/lib/index.js';

export interface ExecutionRepository {
  recordInvocation(entry: InvocationRecord): Promise<void>;
  get(executionId: string): Promise<ExecutionRecord | null>;
  log(entry: ExecutionLogRecord): Promise<ExecutionLogRecord>;
  findByExecutionId(executionId: string): Promise<ExecutionLogRecord[]>;
}

function toJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return JSON.stringify(redactSensitiveFields(value));
}

function redactText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    // Log bodies may be plain text rather than serialized JSON.
    if (error instanceof SyntaxError) return value;
    throw error;
  }
  return toJson(parsed);
}

/** The audit table is optional: with the flag off the operator is told not to create it. */
function auditEnabled(): boolean {
  return process.env.ENABLE_DB_TRANSACTION_LOGS === 'true';
}

/** The executions row was persisted; only the audit row failed. */
export class AuditWriteError extends Error {
  constructor(readonly reason: unknown) {
    super('Execution persisted, but the audit row could not be written');
    this.name = 'AuditWriteError';
  }
}

export class DbExecutionRepository implements ExecutionRepository {
  constructor(private readonly db: DBAdapter) {}

  async recordInvocation(entry: InvocationRecord): Promise<void> {
    const error = entry.error ? {
      ...redactSensitiveFields(entry.error),
      message: redactText(entry.error.message) ?? '',
    } : undefined;
    const log: ExecutionLogRecord = {
      id: generateId(),
      executionId: entry.executionId,
      service: entry.service,
      action: entry.action,
      componentType: entry.componentType,
      status: entry.logStatus,
      requestData: toJson(entry.request),
      responseData: toJson(entry.status === 'FAILED' ? entry.result : entry.response),
      errorMessage: error?.message,
      durationMs: entry.durationMs,
      createdAt: entry.completedAt,
    };

    // Record first; a failed audit write leaves a queryable result, but still rejects.
    // Resolved secret values must already be scrubbed by the runtime.
    await this.db.saveExecution({
      executionId: entry.executionId,
      type: 'service',
      refName: `${entry.service}:${entry.action}`,
      service: entry.service,
      action: entry.action,
      status: entry.status,
      context: redactSensitiveFields(entry.context),
      result: redactSensitiveFields(entry.result ?? null),
      error,
      attempts: entry.attempts,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      createdAt: entry.startedAt,
      updatedAt: entry.completedAt,
    });
    try {
      await this.log(log);
    } catch (reason) {
      // With the flag off the audit table is optional, so a missing table is expected —
      // the trail lives in console/OTel instead. With the flag on it must exist, and the
      // runtime needs to know the execution row was already written.
      if (!auditEnabled()) return;
      throw new AuditWriteError(reason);
    }
  }

  get(executionId: string): Promise<ExecutionRecord | null> {
    return this.db.getExecution(executionId);
  }

  log(entry: ExecutionLogRecord): Promise<ExecutionLogRecord> {
    return this.db.saveExecutionLog({
      ...entry,
      requestData: redactText(entry.requestData),
      responseData: redactText(entry.responseData),
      errorMessage: redactText(entry.errorMessage),
    });
  }

  findByExecutionId(executionId: string): Promise<ExecutionLogRecord[]> {
    return this.db.getExecutionLogs(executionId);
  }
}
