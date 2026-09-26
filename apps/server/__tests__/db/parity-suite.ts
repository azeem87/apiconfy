import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { generateId } from '@/lib/id.js';
import { ConflictError, NotFoundError } from '@/lib/errors.js';
import type {
  ComponentRecord,
  DBAdapter,
  ExecutionLogRecord,
  ExecutionRecord,
  WorkflowRecord,
  WorkflowStepRecord,
} from '@/core/db/adapter.js';

type AdapterFactory = () => Promise<DBAdapter>;

const now = () => new Date().toISOString();

function makeComponent(overrides: Partial<ComponentRecord> = {}): ComponentRecord {
  const id = generateId();
  return {
    id,
    service: `svc-${id}`,
    action: 'create',
    componentType: 'rest',
    config: { uri: 'https://example.com/thing', method: 'POST' },
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  const id = generateId();
  return {
    id,
    name: `wf-${id}`,
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

function makeStep(
  workflowId: string,
  componentId: string,
  stepOrder: number,
  overrides: Partial<WorkflowStepRecord> = {}
): WorkflowStepRecord {
  return {
    id: generateId(),
    workflowId,
    stepOrder,
    stepGroup: 0,
    componentId,
    onFailure: 'halt',
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const executionId = generateId();
  return {
    executionId,
    type: 'service',
    refName: 'svc:create',
    service: 'svc',
    action: 'create',
    status: 'COMPLETED',
    context: { id: '12345' },
    result: { ok: true },
    startedAt: now(),
    completedAt: now(),
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

/**
 * The shared behavioural contract. Every adapter must pass this unchanged —
 * drift prevention comes from these tests, not from shared code
 * (plans/phase3-implementation.md, "Parity Test Suite Architecture").
 */
export function runAdapterParity(
  name: string,
  makeAdapter: AdapterFactory,
  options: { transactions?: boolean; auditTrail?: boolean } = {}
): void {
  const itTx = options.transactions === false ? it.skip : it;
  // The audit table is optional: with ENABLE_DB_TRANSACTION_LOGS off the operator does not
  // create it, so an engine suite without it skips this test explicitly rather than failing.
  const itAudit = options.auditTrail === false ? it.skip : it;

  describe(`${name} — DBAdapter parity`, () => {
    let db: DBAdapter;

    beforeAll(async () => {
      db = await makeAdapter();
      await db.connect();
    });

    afterAll(async () => {
      await db?.disconnect();
    });

    describe('component CRUD', () => {
      it('creates and reads a component back', async () => {
        const comp = makeComponent();
        await db.saveComponent(comp);
        const found = await db.getComponent(comp.id);
        expect(found?.id).toBe(comp.id);
        expect(found?.service).toBe(comp.service);
        expect(found?.config).toEqual(comp.config);
      });

      it('finds by natural key', async () => {
        const comp = makeComponent();
        await db.saveComponent(comp);
        const found = await db.findComponent(comp.service, comp.action);
        expect(found?.id).toBe(comp.id);
      });

      it('rejects a duplicate natural key with ConflictError', async () => {
        const comp = makeComponent();
        await db.saveComponent(comp);
        await expect(
          db.saveComponent({ ...makeComponent(), service: comp.service, action: comp.action })
        ).rejects.toThrow(ConflictError);
      });

      it('increments version on update and returns the new row', async () => {
        const comp = makeComponent({ version: 3 });
        await db.saveComponent(comp);
        const updated = await db.updateComponent(comp.id, {
          config: { uri: 'https://example.com/v2', method: 'PUT' },
          version: comp.version,
        });
        expect(updated.version).toBe(4);
        expect(updated.config).toEqual({ uri: 'https://example.com/v2', method: 'PUT' });
      });

      it('lists with filters, pagination and a deterministic order', async () => {
        const service = `svc-list-${generateId()}`;
        for (let i = 0; i < 3; i += 1) {
          await db.saveComponent(
            makeComponent({ service, action: `act-${i}`, componentType: i === 0 ? 'rest' : 'mapper' })
          );
        }
        const page = await db.listComponents({ service }, 2, 1);
        expect(page).toHaveLength(2);
        const all = await db.listComponents({ service });
        const again = await db.listComponents({ service });
        expect(again.map((c) => c.id)).toEqual(all.map((c) => c.id));
        expect(all.slice(1, 3).map((c) => c.id)).toEqual(page.map((c) => c.id));
        const onlyRest = await db.listComponents({ service, componentType: 'rest' });
        expect(onlyRest).toHaveLength(1);
      });

      it('counts filtered rows', async () => {
        const service = `svc-count-${generateId()}`;
        await db.saveComponent(makeComponent({ service, action: 'act-1' }));
        await db.saveComponent(makeComponent({ service, action: 'act-2' }));
        expect(await db.countComponents({ service })).toBe(2);
      });

      it('round-trips nested JSON', async () => {
        const config = {
          uri: 'https://example.com/deep',
          method: 'POST',
          headers: { 'x-trace': 'abc', nested: { list: [1, 2, { deep: ['a', 'b'] }] } },
        };
        const comp = makeComponent({ config });
        await db.saveComponent(comp);
        expect((await db.getComponent(comp.id))?.config).toEqual(config);
      });

      it('deletes, then reports NotFound on the second delete', async () => {
        const comp = makeComponent();
        await db.saveComponent(comp);
        await db.deleteComponent(comp.id);
        expect(await db.getComponent(comp.id)).toBeNull();
        await expect(db.deleteComponent(comp.id)).rejects.toThrow(NotFoundError);
      });
    });

    describe('workflow + steps', () => {
      it('saves a workflow and finds it by name', async () => {
        const wf = makeWorkflow();
        await db.saveWorkflow(wf);
        const found = await db.findWorkflowByName(wf.name);
        expect(found?.id).toBe(wf.id);
        expect(await db.getWorkflow(wf.id)).not.toBeNull();
      });

      itTx('saves workflow and steps atomically in one transaction', async () => {
        const comp = makeComponent();
        await db.saveComponent(comp);
        const wf = makeWorkflow();
        const returned = await db.transaction(async (tx) => {
          await tx.saveWorkflow(wf);
          await tx.saveWorkflowStep(makeStep(wf.id, comp.id, 0));
          await tx.saveWorkflowStep(makeStep(wf.id, comp.id, 1));
          return 'committed';
        });
        expect(returned).toBe('committed');
        expect(await db.getWorkflow(wf.id)).not.toBeNull();
        expect(await db.getWorkflowSteps(wf.id)).toHaveLength(2);
      });

      itTx('rolls the transaction back when a step is invalid', async () => {
        const wf = makeWorkflow();
        await expect(
          db.transaction(async (tx) => {
            await tx.saveWorkflow(wf);
            await tx.saveWorkflowStep(makeStep(wf.id, 'missing-component-id', 0));
          })
        ).rejects.toThrow(ConflictError);
        expect(await db.getWorkflow(wf.id)).toBeNull();
      });

      it('cascades steps when the workflow is deleted', async () => {
        const comp = makeComponent();
        await db.saveComponent(comp);
        const wf = makeWorkflow();
        await db.saveWorkflow(wf);
        await db.saveWorkflowStep(makeStep(wf.id, comp.id, 0));
        await db.deleteWorkflow(wf.id);
        expect(await db.getWorkflowSteps(wf.id)).toHaveLength(0);
      });

      it('returns steps in step order', async () => {
        const comp = makeComponent();
        await db.saveComponent(comp);
        const wf = makeWorkflow();
        await db.saveWorkflow(wf);
        await db.saveWorkflowStep(makeStep(wf.id, comp.id, 2));
        await db.saveWorkflowStep(makeStep(wf.id, comp.id, 0));
        await db.saveWorkflowStep(makeStep(wf.id, comp.id, 1));
        const steps = await db.getWorkflowSteps(wf.id);
        expect(steps.map((s) => s.stepOrder)).toEqual([0, 1, 2]);
      });

      it('stores compensation config and rejects deleting a referenced component', async () => {
        const comp = makeComponent();
        await db.saveComponent(comp);
        const wf = makeWorkflow({
          compensationFailureConfig: { maxRetries: 2, onExhausted: 'deadLetter' },
        });
        await db.saveWorkflow(wf);
        await db.saveWorkflowStep(makeStep(wf.id, comp.id, 0, { onFailure: 'compensate' }));
        expect((await db.getWorkflow(wf.id))?.compensationFailureConfig).toEqual({
          maxRetries: 2,
          onExhausted: 'deadLetter',
        });
        await expect(db.deleteComponent(comp.id)).rejects.toThrow(ConflictError);
      });
    });

    describe('execution tracking', () => {
      it('saves an execution and reads it back', async () => {
        const execution = makeExecution();
        await db.saveExecution(execution);
        const found = await db.getExecution(execution.executionId);
        expect(found?.context).toEqual({ id: '12345' });
        expect(found?.result).toEqual({ ok: true });
        expect(found?.status).toBe('COMPLETED');
      });

      it('defaults attempts to zero before dispatch', async () => {
        const execution = { ...makeExecution(), attempts: undefined };
        await db.saveExecution(execution);
        expect((await db.getExecution(execution.executionId))?.attempts).toBe(0);
      });

      itAudit('writes and reads execution logs in order', async () => {
        const execution = makeExecution();
        await db.saveExecution(execution);
        const log = (createdAt: string): ExecutionLogRecord => ({
          id: generateId(),
          executionId: execution.executionId,
          status: 'success',
          durationMs: 12,
          createdAt,
        });
        await db.saveExecutionLog(log('2026-09-19T10:00:01.000Z'));
        await db.saveExecutionLog(log('2026-09-19T10:00:00.000Z'));
        const logs = await db.getExecutionLogs(execution.executionId);
        expect(logs).toHaveLength(2);
        expect(logs[0].createdAt).toBe('2026-09-19T10:00:00.000Z');
      });
    });

    describe('config store', () => {
      it('sets and gets a value', async () => {
        const key = `cfg-${generateId()}`;
        await db.setConfig(key, '15', 'number');
        expect(await db.getConfig(key)).toBe('15');
      });

      it('upserts on a second set', async () => {
        const key = `cfg-${generateId()}`;
        await db.setConfig(key, 'first', 'string');
        await db.setConfig(key, 'second', 'string');
        expect(await db.getConfig(key)).toBe('second');
      });

      it('reports NotFound when deleting a missing key', async () => {
        await expect(db.deleteConfig(`absent-${generateId()}`)).rejects.toThrow(NotFoundError);
      });
    });

    describe('edge cases', () => {
      it('returns an empty list for unknown filters', async () => {
        expect(await db.listComponents({ service: `nope-${generateId()}` })).toEqual([]);
        expect(await db.listComponents({ service: `nope-${generateId()}` }, 10, 0)).toEqual([]);
      });

      it('round-trips a large JSON payload', async () => {
        const big = {
          items: Array.from({ length: 200 }, (_, i) => ({ i, label: `item-${i}` })),
          blob: 'x'.repeat(50_000),
        };
        const comp = makeComponent({ config: big });
        await db.saveComponent(comp);
        expect((await db.getComponent(comp.id))?.config).toEqual(big);
      });

      it('handles unicode in the natural key', async () => {
        const comp = makeComponent({ service: `svc-ünïcødé-${generateId()}`, action: 'créate-日本' });
        await db.saveComponent(comp);
        expect((await db.findComponent(comp.service, comp.action))?.id).toBe(comp.id);
      });

      it('returns null for a missing component and undefined optional fields', async () => {
        expect(await db.getComponent(`absent-${generateId()}`)).toBeNull();
        const comp = makeComponent();
        await db.saveComponent(comp);
        const found = await db.getComponent(comp.id);
        expect(found?.description).toBeUndefined();
        expect(found?.condition).toBeUndefined();
        expect(found?.metaData).toBeUndefined();
      });

      it('orders rows deterministically when timestamps collide', async () => {
        const service = `svc-order-${generateId()}`;
        const createdAt = now();
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          const comp = makeComponent({ service, action: `act-${i}`, createdAt, updatedAt: createdAt });
          ids.push(comp.id);
          await db.saveComponent(comp);
        }
        const listed = (await db.listComponents({ service })).map((c) => c.id);
        expect(listed).toEqual([...ids].sort());
      });

      it('handles concurrent reads', async () => {
        const comp = makeComponent();
        await db.saveComponent(comp);
        const results = await Promise.all(Array.from({ length: 5 }, () => db.getComponent(comp.id)));
        expect(results.every((row) => row?.id === comp.id)).toBe(true);
      });

      it('handles sequential writes then counts them all', async () => {
        const service = `svc-seq-${generateId()}`;
        for (let i = 0; i < 10; i += 1) {
          await db.saveComponent(makeComponent({ service, action: `act-${i}` }));
        }
        expect(await db.countComponents({ service })).toBe(10);
      });

      itTx('returns the transaction callback value', async () => {
        const value = await db.transaction(async () => {
          const comp = makeComponent();
          await db.saveComponent(comp);
          return comp.id;
        });
        expect(await db.getComponent(value)).not.toBeNull();
      });
    });
  });
}
