import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';
import type { DBAdapter } from '@/core/db/adapter.js';
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
        serviceName: 'test-svc',
        serviceType: 'get_user',
        component: 'rest',
        serviceDetails: { url: 'https://example.com', method: 'GET' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const found = await adapter.getComponent(comp.id);
      expect(found).not.toBeNull();
      expect(found!.serviceName).toBe('test-svc');
    });

    it('finds component by natural key', async () => {
      const id = generateId();
      await adapter.saveComponent({ id, serviceName: 'customer-svc', serviceType: 'create', component: 'rest', serviceDetails: {}, createdAt: now(), updatedAt: now() });
      const found = await adapter.findComponent('customer-svc', 'rest', 'create');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
    });

    it('returns null for non-existent component', async () => {
      expect(await adapter.getComponent('non-existent')).toBeNull();
    });

    it('updates a component', async () => {
      const comp = await adapter.saveComponent({ id: generateId(), serviceName: 'upd', serviceType: 'x', component: 'rest', serviceDetails: {}, createdAt: now(), updatedAt: now() });
      const updated = await adapter.updateComponent(comp.id, { description: 'new desc' });
      expect(updated.description).toBe('new desc');
    });

    it('deletes a component', async () => {
      const comp = await adapter.saveComponent({ id: generateId(), serviceName: 'del', serviceType: 'x', component: 'rest', serviceDetails: {}, createdAt: now(), updatedAt: now() });
      await adapter.deleteComponent(comp.id);
      expect(await adapter.getComponent(comp.id)).toBeNull();
    });
  });

  describe('list components', () => {
    it('lists with default pagination', async () => {
      const results = await adapter.listComponents();
      expect(Array.isArray(results)).toBe(true);
    });

    it('filters by serviceName', async () => {
      await adapter.saveComponent({ id: generateId(), serviceName: 'filter-me', serviceType: 'x', component: 'rest', serviceDetails: {}, createdAt: now(), updatedAt: now() });
      const results = await adapter.listComponents({ serviceName: 'filter-me' });
      expect(results.every(r => r.serviceName === 'filter-me')).toBe(true);
    });
  });

  describe('workflow CRUD', () => {
    it('saves, finds, updates, lists, and deletes', async () => {
      const wf = await adapter.saveWorkflow({ id: generateId(), name: 'wf1', createdAt: now(), updatedAt: now() });
      expect((await adapter.findWorkflowByName('wf1'))!.id).toBe(wf.id);
      expect((await adapter.getWorkflow(wf.id))!.name).toBe('wf1');

      const updated = await adapter.updateWorkflow(wf.id, { name: 'wf-renamed' });
      expect(updated.name).toBe('wf-renamed');

      const list = await adapter.listWorkflows();
      expect(list.length).toBeGreaterThanOrEqual(1);

      await adapter.deleteWorkflow(wf.id);
      expect(await adapter.getWorkflow(wf.id)).toBeNull();
    });
  });

  describe('workflow steps', () => {
    it('saves and retrieves steps', async () => {
      const comp = await adapter.saveComponent({ id: generateId(), serviceName: 'ws1', serviceType: 'x', component: 'rest', serviceDetails: {}, createdAt: now(), updatedAt: now() });
      const wf = await adapter.saveWorkflow({ id: generateId(), name: 'wf-steps', createdAt: now(), updatedAt: now() });
      const step = await adapter.saveWorkflowStep({ id: generateId(), workflowId: wf.id, stepOrder: 1, stepGroup: 0, componentId: comp.id, rollbackAllPrevious: false });
      const steps = await adapter.getWorkflowSteps(wf.id);
      expect(steps.length).toBe(1);
      expect(steps[0].id).toBe(step.id);
    });
  });

  describe('execution logs', () => {
    it('saves and retrieves logs', async () => {
      const execId = generateId();
      await adapter.saveExecutionLog({ id: generateId(), executionId: execId, status: 'success', createdAt: now() });
      await adapter.saveExecutionLog({ id: generateId(), executionId: execId, serviceName: 'svc', status: 'failed', errorMessage: 'oops', durationMs: 100, createdAt: now() });
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
