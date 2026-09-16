import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';
import type { DBAdapter, ExecutionRecord } from '@/core/db/adapter.js';
import { generateId } from '@/lib/index.js';

describe('SQLite Adapter', () => {
  let adapter: DBAdapter;

  beforeAll(async () => {
    adapter = createSqliteAdapter(':memory:');
    await adapter.connect();
  });

  afterAll(async () => {
    await adapter.disconnect();
  });

  describe('component CRUD', () => {
    it('saves and retrieves a component', async () => {
      const comp = await adapter.saveComponent({
        id: generateId(),
        service: 'test-svc',
        action: 'get_user',
        componentType: 'rest',
        config: { request: { uri: 'https://example.com', method: 'GET' } },
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const found = await adapter.getComponent(comp.id);
      expect(found).not.toBeNull();
      expect(found!.service).toBe('test-svc');
    });

    it('finds component by natural key', async () => {
      const id = generateId();
      await adapter.saveComponent({ id, service: 'customer-svc', action: 'create', componentType: 'rest', config: {}, version: 1, createdAt: now(), updatedAt: now() });
      const found = await adapter.findComponent('customer-svc', 'create');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
    });

    it('returns null for non-existent component', async () => {
      expect(await adapter.getComponent('non-existent')).toBeNull();
    });

    it('updates a component', async () => {
      const comp = await adapter.saveComponent({ id: generateId(), service: 'upd', action: 'x', componentType: 'rest', config: {}, version: 1, createdAt: now(), updatedAt: now() });
      const updated = await adapter.updateComponent(comp.id, { description: 'new desc', version: comp.version });
      expect(updated.description).toBe('new desc');
      expect(updated.version).toBe(2);
    });

    it('deletes a component', async () => {
      const comp = await adapter.saveComponent({ id: generateId(), service: 'del', action: 'x', componentType: 'rest', config: {}, version: 1, createdAt: now(), updatedAt: now() });
      await adapter.deleteComponent(comp.id);
      expect(await adapter.getComponent(comp.id)).toBeNull();
    });
  });

  describe('list components', () => {
    it('lists with default pagination', async () => {
      const results = await adapter.listComponents();
      expect(Array.isArray(results)).toBe(true);
    });

    it('filters by service', async () => {
      await adapter.saveComponent({ id: generateId(), service: 'filter-me', action: 'x', componentType: 'rest', config: {}, version: 1, createdAt: now(), updatedAt: now() });
      const results = await adapter.listComponents({ service: 'filter-me' });
      expect(results.every(r => r.service === 'filter-me')).toBe(true);
    });
  });

  describe('workflow CRUD', () => {
    it('saves, finds, updates, lists, and deletes', async () => {
      const wf = await adapter.saveWorkflow({
        id: generateId(),
        name: 'wf1',
        groupId: 'group-a',
        maxDurationMs: 30000,
        compensationFailureConfig: { maxRetries: 3, onExhausted: 'deadLetter' },
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      });
      expect((await adapter.findWorkflowByName('wf1'))!.id).toBe(wf.id);
      expect((await adapter.getWorkflow(wf.id))!.name).toBe('wf1');

      const fetched = (await adapter.getWorkflow(wf.id))!;
      expect(fetched.groupId).toBe('group-a');
      expect(fetched.maxDurationMs).toBe(30000);
      expect(fetched.compensationFailureConfig).toEqual({ maxRetries: 3, onExhausted: 'deadLetter' });

      const updated = await adapter.updateWorkflow(wf.id, { name: 'wf-renamed', groupId: 'group-b', version: wf.version });
      expect(updated.name).toBe('wf-renamed');
      expect(updated.groupId).toBe('group-b');
      expect(updated.version).toBe(2);

      const list = await adapter.listWorkflows();
      expect(list.length).toBeGreaterThanOrEqual(1);

      await adapter.deleteWorkflow(wf.id);
      expect(await adapter.getWorkflow(wf.id)).toBeNull();
    });

    it('leaves optional saga fields undefined when omitted', async () => {
      const wf = await adapter.saveWorkflow({ id: generateId(), name: 'wf-minimal', version: 1, createdAt: now(), updatedAt: now() });
      const fetched = (await adapter.getWorkflow(wf.id))!;
      expect(fetched.groupId).toBeUndefined();
      expect(fetched.maxDurationMs).toBeUndefined();
      expect(fetched.compensationFailureConfig).toBeUndefined();
    });
  });

  describe('workflow steps', () => {
    it('saves and retrieves steps', async () => {
      const comp = await adapter.saveComponent({ id: generateId(), service: 'ws1', action: 'x', componentType: 'rest', config: {}, version: 1, createdAt: now(), updatedAt: now() });
      const wf = await adapter.saveWorkflow({ id: generateId(), name: 'wf-steps', version: 1, createdAt: now(), updatedAt: now() });
      const step = await adapter.saveWorkflowStep({
        id: generateId(),
        workflowId: wf.id,
        name: 'Create Customer',
        stepOrder: 1,
        stepGroup: 0,
        componentId: comp.id,
        compensationService: 'customer-service',
        compensationAction: 'delete_customer',
        condition: '$.id != null',
        onFailure: 'compensate',
        idempotencyKeyHeader: 'x-idempotency-key',
        verifyAction: 'get_customer',
      });
      const steps = await adapter.getWorkflowSteps(wf.id);
      expect(steps.length).toBe(1);
      expect(steps[0].id).toBe(step.id);
      expect(steps[0].name).toBe('Create Customer');
      expect(steps[0].compensationService).toBe('customer-service');
      expect(steps[0].compensationAction).toBe('delete_customer');
      expect(steps[0].condition).toBe('$.id != null');
      expect(steps[0].onFailure).toBe('compensate');
      expect(steps[0].idempotencyKeyHeader).toBe('x-idempotency-key');
      expect(steps[0].verifyAction).toBe('get_customer');
    });

    it('defaults onFailure to halt and leaves compensation fields unset', async () => {
      const comp = await adapter.saveComponent({ id: generateId(), service: 'ws2', action: 'x', componentType: 'rest', config: {}, version: 1, createdAt: now(), updatedAt: now() });
      const wf = await adapter.saveWorkflow({ id: generateId(), name: 'wf-steps-minimal', version: 1, createdAt: now(), updatedAt: now() });
      await adapter.saveWorkflowStep({ id: generateId(), workflowId: wf.id, stepOrder: 1, stepGroup: 0, componentId: comp.id, onFailure: 'halt' });
      const [step] = await adapter.getWorkflowSteps(wf.id);
      expect(step.onFailure).toBe('halt');
      expect(step.compensationAction).toBeUndefined();
      expect(step.condition).toBeUndefined();
    });
  });

  describe('executions', () => {
    const execution = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
      executionId: generateId(),
      type: 'service',
      refName: 'svc:act',
      service: 'svc',
      action: 'act',
      status: 'COMPLETED',
      context: { customer: { id: 123 } },
      startedAt: '2026-09-14T06:00:00.000Z',
      completedAt: '2026-09-14T06:00:00.010Z',
      createdAt: '2026-09-14T06:00:00.000Z',
      updatedAt: '2026-09-14T06:00:00.010Z',
      ...overrides,
    });

    it.each([null, false, 0, '', 'text', [1, null], { ok: true }].map(result => ({ result })))(
      'round-trips JSON result %j',
      async ({ result }) => {
        const record = execution({ result, attempts: 2 });
        const saved = await adapter.saveExecution(record);
        expect(saved.result).toEqual(result);
        expect(await adapter.getExecution(record.executionId)).toMatchObject(record);
      },
    );

    it('round-trips structured errors and optional execution fields', async () => {
      const record = execution({
        type: 'saga',
        service: undefined,
        action: undefined,
        groupId: 'group-1',
        steps: [{ name: 'first', status: 'FAILED', attempts: 2 }],
        status: 'FAILED',
        result: { error: true },
        error: { code: 'VALIDATION_FAILED', message: 'invalid result', details: { expression: '$.response.id', items: [null, false] } },
        maxDurationMs: 1000,
        attempts: 2,
      });
      await adapter.saveExecution(record);
      expect(await adapter.getExecution(record.executionId)).toEqual(record);
    });

    it.each([null, false, 0, '', ['problem']].map(details => ({ details })))('round-trips error details %j', async ({ details }) => {
      const record = execution({ error: { code: 'ERROR', message: '', details } });
      await adapter.saveExecution(record);
      expect((await adapter.getExecution(record.executionId))?.error).toEqual(record.error);
    });

    it('defaults attempts and absent results without fabricating errors', async () => {
      const record = execution({ completedAt: undefined });
      const saved = await adapter.saveExecution(record);
      expect(saved.attempts).toBe(1);
      expect(saved.result).toBeNull();
      expect(saved.error).toBeUndefined();
      expect(saved.steps).toBeUndefined();
      expect(saved.groupId).toBeUndefined();
      expect(saved.completedAt).toBeUndefined();
    });

    it('returns null for a missing execution and rejects duplicate ids', async () => {
      expect(await adapter.getExecution('missing')).toBeNull();
      const record = execution();
      await adapter.saveExecution(record);
      await expect(adapter.saveExecution(record)).rejects.toThrow();
    });

    it('adds the executions table to a Phase 1 database without changing stored definitions', async () => {
      const sqlite = new Database(':memory:');
      const upgraded = createSqliteAdapter(sqlite);
      await upgraded.connect();
      try {
        const component = await upgraded.saveComponent({
          id: generateId(), service: 'existing', action: 'act', componentType: 'rest',
          config: { request: { uri: 'https://example.test', method: 'GET' }, auth: { basic: { username: 'u', password: '$env.PW' } } },
          version: 1,
          createdAt: now(), updatedAt: now(),
        });
        sqlite.exec('DROP TABLE executions');
        await upgraded.connect();
        expect(await upgraded.getComponent(component.id)).toEqual(component);
        const record = execution({ result: null });
        await upgraded.saveExecution(record);
        expect(await upgraded.getExecution(record.executionId)).toMatchObject(record);
        await upgraded.connect();
        expect(await upgraded.getExecution(record.executionId)).toMatchObject(record);
      } finally {
        await upgraded.disconnect();
      }
    });
  });

  describe('execution logs', () => {
    it('saves and retrieves logs', async () => {
      const execId = generateId();
      await adapter.saveExecutionLog({ id: generateId(), executionId: execId, status: 'success', createdAt: now() });
      await adapter.saveExecutionLog({ id: generateId(), executionId: execId, service: 'svc', status: 'failed', errorMessage: 'oops', durationMs: 100, createdAt: now() });
      const logs = await adapter.getExecutionLogs(execId);
      expect(logs.length).toBe(2);
      expect(logs[1].status).toBe('failed');
      expect(logs[1].errorMessage).toBe('oops');
    });
  });

  describe('master configuration', () => {
    it('sets, gets, and deletes config', async () => {
      expect(await adapter.getConfig('test-key')).toBeNull();
      await adapter.setConfig('test-key', 'val', 'string');
      expect(await adapter.getConfig('test-key')).toBe('val');
      await adapter.setConfig('test-key', 'updated', 'string');
      expect(await adapter.getConfig('test-key')).toBe('updated');
      await adapter.deleteConfig('test-key');
      expect(await adapter.getConfig('test-key')).toBeNull();
    });
  });
});

function now(): string {
  return new Date().toISOString();
}
