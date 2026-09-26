import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { DBAdapter } from '@/core/db/adapter.js';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';
import { AuditWriteError, DbExecutionRepository } from '@/core/db/repositories/execution.repository.js';
import type { InvocationRecord } from '@/core/runtime/types.js';
import { generateId } from '@/lib/index.js';

const invocation = (): InvocationRecord => ({
  executionId: generateId(),
  service: 'svc',
  action: 'act',
  componentType: 'rest',
  status: 'COMPLETED',
  logStatus: 'success',
  context: { id: 1 },
  result: { ok: true },
  request: { uri: 'https://example.test', method: 'POST' },
  response: { ok: true },
  attempts: 1,
  durationMs: 5,
  startedAt: '2026-09-19T06:00:00.000Z',
  completedAt: '2026-09-19T06:00:00.005Z',
});

describe('audit trail flag (ENABLE_DB_TRANSACTION_LOGS)', () => {
  let sqlite: Database;
  let db: DBAdapter;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    db = createSqliteAdapter(sqlite);
    await db.connect();
  });

  afterEach(async () => {
    delete process.env.ENABLE_DB_TRANSACTION_LOGS;
    await db.disconnect();
  });

  it('swallows a missing audit table when the flag is off', async () => {
    sqlite.exec('DROP TABLE execution_logs');
    process.env.ENABLE_DB_TRANSACTION_LOGS = 'false';

    const entry = invocation();
    await new DbExecutionRepository(db).recordInvocation(entry);

    // Resolved — no AuditWriteError — and the execution row is queryable.
    expect(await db.getExecution(entry.executionId)).not.toBeNull();
  });

  it('still writes the audit row when the flag is off but the table exists', async () => {
    process.env.ENABLE_DB_TRANSACTION_LOGS = 'false';

    const entry = invocation();
    await new DbExecutionRepository(db).recordInvocation(entry);

    expect(await db.getExecutionLogs(entry.executionId)).toHaveLength(1);
  });

  it('separates an audit failure from an execution failure when the flag is on', async () => {
    sqlite.exec('DROP TABLE execution_logs');
    process.env.ENABLE_DB_TRANSACTION_LOGS = 'true';

    const entry = invocation();
    await expect(new DbExecutionRepository(db).recordInvocation(entry)).rejects.toBeInstanceOf(AuditWriteError);

    // The execution row is still queryable — that is what the tagged error tells the runtime.
    expect(await db.getExecution(entry.executionId)).not.toBeNull();
  });

  it('writes both rows when the flag is on and the table exists', async () => {
    process.env.ENABLE_DB_TRANSACTION_LOGS = 'true';

    const entry = invocation();
    await new DbExecutionRepository(db).recordInvocation(entry);

    expect(await db.getExecution(entry.executionId)).not.toBeNull();
    expect(await db.getExecutionLogs(entry.executionId)).toHaveLength(1);
  });
});
