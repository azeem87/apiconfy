import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { DBAdapter } from '@/core/db/adapter.js';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';
import { DbExecutionRepository } from '@/core/db/repositories/execution.repository.js';
import type { InvocationRecord } from '@/core/runtime/types.js';
import { generateId } from '@/lib/index.js';

const invocation = (overrides: Partial<InvocationRecord> = {}): InvocationRecord => ({
  executionId: generateId(),
  service: 'svc',
  action: 'act',
  componentType: 'rest',
  status: 'COMPLETED',
  logStatus: 'success',
  context: { customerId: 123 },
  result: { customerResponse: { id: 123 } },
  request: { uri: 'https://example.test', method: 'POST', body: { id: 123 } },
  response: { id: 123 },
  attempts: 2,
  durationMs: 10,
  startedAt: '2026-09-14T06:00:00.000Z',
  completedAt: '2026-09-14T06:00:00.010Z',
  ...overrides,
});

describe('DbExecutionRepository', () => {
  let db: DBAdapter;
  let repo: DbExecutionRepository;

  beforeEach(async () => {
    db = createSqliteAdapter(':memory:');
    await db.connect();
    repo = new DbExecutionRepository(db);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  it('writes a queryable execution and a raw-response audit log', async () => {
    const entry = invocation();
    await repo.recordInvocation(entry);
    const record = await repo.get(entry.executionId);
    expect(record).toMatchObject({
      executionId: entry.executionId,
      type: 'service',
      refName: 'svc:act',
      service: 'svc',
      action: 'act',
      status: 'COMPLETED',
      context: entry.context,
      result: entry.result,
      attempts: 2,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      createdAt: entry.startedAt,
      updatedAt: entry.completedAt,
    });
    expect(record?.steps).toBeUndefined();
    const logs = await repo.findByExecutionId(entry.executionId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      executionId: entry.executionId,
      service: 'svc',
      action: 'act',
      componentType: 'rest',
      status: 'success',
      requestData: JSON.stringify(entry.request),
      responseData: JSON.stringify(entry.response),
      durationMs: 10,
      createdAt: entry.completedAt,
    });
    expect(logs[0].stepOrder).toBeUndefined();
  });

  it('redacts nested context, request, result, response and structured error details without mutation', async () => {
    const entry = invocation({
      context: { password: 'input-secret', nested: [{ token: 'nested-secret' }] },
      request: { uri: 'https://example.test', method: 'POST', body: { password: 'body-secret' } },
      result: { customerResponse: { clientSecret: 'result-secret' } },
      response: { clientSecret: 'response-secret' },
      error: { code: 'ERROR', message: '{"password":"error-secret"}', details: { nested: [{ apiKey: 'detail-secret' }] } },
    });
    await repo.recordInvocation(entry);
    const record = await db.getExecution(entry.executionId);
    expect(record?.context).toEqual({ password: '***', nested: [{ token: '***' }] });
    expect(record?.result).toEqual({ customerResponse: { clientSecret: '***' } });
    expect(record?.error).toEqual({
      code: 'ERROR',
      message: '{"password":"***"}',
      details: { nested: [{ apiKey: '***' }] },
    });
    const [log] = await db.getExecutionLogs(entry.executionId);
    expect(JSON.parse(log.requestData!).body).toEqual({ password: '***' });
    expect(JSON.parse(log.responseData!)).toEqual({ clientSecret: '***' });
    expect(log.errorMessage).toBe('{"password":"***"}');
    expect(entry.context.password).toBe('input-secret');
    expect(entry.result).toEqual({ customerResponse: { clientSecret: 'result-secret' } });
  });

  it('stores the failed transformed result rather than the raw upstream response', async () => {
    const entry = invocation({
      status: 'FAILED',
      logStatus: 'failed',
      result: { customerResponse: { error: { code: 'UPSTREAM', password: 'secret' } } },
      response: { raw: 'not the transformed result' },
      error: { code: 'UPSTREAM', message: 'request failed', details: { token: 'secret' } },
    });
    await repo.recordInvocation(entry);
    const record = await repo.get(entry.executionId);
    const [log] = await repo.findByExecutionId(entry.executionId);
    expect(record?.status).toBe('FAILED');
    expect(record?.error?.details).toEqual({ token: '***' });
    expect(log.status).toBe('failed');
    expect(JSON.parse(log.responseData!)).toEqual(record?.result);
    expect(log.responseData).not.toContain('raw');
  });

  it.each([null, false, 0, '', 'text', [null, { password: 'secret' }]].map(value => ({ value })))(
    'preserves JSON scalar/array result and response %j',
    async ({ value }) => {
      const entry = invocation({ result: value, response: value });
      await repo.recordInvocation(entry);
      const record = await repo.get(entry.executionId);
      const [log] = await repo.findByExecutionId(entry.executionId);
      expect(record?.result).toEqual(Array.isArray(value) ? [null, { password: '***' }] : value);
      expect(JSON.parse(log.responseData!)).toEqual(record?.result);
    },
  );

  it('records skipped calls as completed with no request or response', async () => {
    const entry = invocation({
      logStatus: 'skipped', attempts: 0, result: null, request: undefined, response: undefined,
    });
    await repo.recordInvocation(entry);
    expect(await repo.get(entry.executionId)).toMatchObject({ status: 'COMPLETED', attempts: 0, result: null });
    const [log] = await repo.findByExecutionId(entry.executionId);
    expect(log.status).toBe('skipped');
    expect(log.requestData).toBeUndefined();
    expect(log.responseData).toBeUndefined();
  });

  it('returns null/empty logs for missing ids and keeps invocations independent', async () => {
    expect(await repo.get('missing')).toBeNull();
    expect(await repo.findByExecutionId('missing')).toEqual([]);
    const first = invocation();
    const second = invocation({ result: 42 });
    await repo.recordInvocation(first);
    await repo.recordInvocation(second);
    expect((await repo.get(first.executionId))?.result).toEqual(first.result);
    expect((await repo.get(second.executionId))?.result).toBe(42);
    expect(await repo.findByExecutionId(first.executionId)).toHaveLength(1);
    expect(await repo.findByExecutionId(second.executionId)).toHaveLength(1);
  });

  it('redacts direct JSON log payloads while preserving non-JSON text', async () => {
    const entry = {
      id: generateId(),
      executionId: generateId(),
      status: 'failed' as const,
      requestData: '{"password":"secret"}',
      responseData: '[{"clientSecret":"secret"}]',
      errorMessage: 'plain error message',
      createdAt: invocation().completedAt,
    };
    const log = await repo.log(entry);
    expect(log.requestData).toBe('{"password":"***"}');
    expect(log.responseData).toBe('[{"clientSecret":"***"}]');
    expect(log.errorMessage).toBe(entry.errorMessage);
    expect(entry.requestData).toContain('secret');
    expect(await repo.findByExecutionId(entry.executionId)).toEqual([log]);
  });

  it('propagates serialization errors rather than silently dropping audit payloads', async () => {
    const entry = invocation({ response: { unsupported: 1n } });
    await expect(repo.recordInvocation(entry)).rejects.toThrow();
    expect(await repo.get(entry.executionId)).toBeNull();
    expect(await repo.findByExecutionId(entry.executionId)).toEqual([]);
  });

  it('propagates a failed execution write without writing a log', async () => {
    const entry = invocation();
    const broken = new DbExecutionRepository({
      ...db,
      saveExecution: async () => { throw new Error('disk I/O error'); },
    });
    await expect(broken.recordInvocation(entry)).rejects.toThrow('disk I/O error');
    expect(await repo.get(entry.executionId)).toBeNull();
    expect(await repo.findByExecutionId(entry.executionId)).toEqual([]);
  });

  it('retains the record but rejects when the second audit write fails', async () => {
    const entry = invocation();
    const broken = new DbExecutionRepository({
      ...db,
      saveExecutionLog: async () => { throw new Error('audit write failed'); },
    });
    await expect(broken.recordInvocation(entry)).rejects.toThrow('audit write failed');
    expect(await repo.get(entry.executionId)).not.toBeNull();
    expect(await repo.findByExecutionId(entry.executionId)).toEqual([]);
  });
});
