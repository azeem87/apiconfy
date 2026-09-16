import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';
import { DbComponentRepository } from '@/core/db/repositories/component.repository.js';
import type { DBAdapter } from '@/core/db/adapter.js';
import { ConflictError } from '@/lib/errors.js';
import { generateId } from '@/lib/id.js';

describe('Optimistic Concurrency Control', () => {
  let db: DBAdapter;
  let repo: DbComponentRepository;

  beforeEach(async () => {
    db = createSqliteAdapter(':memory:');
    await db.connect();
    repo = new DbComponentRepository(db);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  describe('Component versioning', () => {
    it('starts with version 1 on creation', async () => {
      const record = await repo.create({
        service: 'test-svc',
        action: 'create',
        componentType: 'rest',
        config: { request: { uri: 'https://example.com', method: 'GET' } },
      });
      expect(record.version).toBe(1);
    });

    it('increments version on update', async () => {
      const v1 = await repo.create({
        service: 'test-svc',
        action: 'update-test',
        componentType: 'rest',
        config: { request: { uri: 'https://example.com', method: 'GET' } },
      });
      expect(v1.version).toBe(1);

      const v2 = await repo.update('test-svc', 'update-test', {
        componentType: 'rest',
        config: { request: { uri: 'https://example.com/v2', method: 'GET' } },
        version: v1.version,
      });
      expect(v2.version).toBe(2);

      const v3 = await repo.update('test-svc', 'update-test', {
        componentType: 'rest',
        config: { request: { uri: 'https://example.com/v3', method: 'GET' } },
        version: v2.version,
      });
      expect(v3.version).toBe(3);
    });

    it('throws ConflictError when version mismatch on update', async () => {
      const v1 = await repo.create({
        service: 'test-svc',
        action: 'conflict-test',
        componentType: 'rest',
        config: { request: { uri: 'https://example.com', method: 'GET' } },
      });

      // Simulate another client updating the record
      await repo.update('test-svc', 'conflict-test', {
        componentType: 'rest',
        config: { request: { uri: 'https://example.com/v2', method: 'GET' } },
        version: v1.version,
      });

      // Try to update with stale version
      expect(repo.update('test-svc', 'conflict-test', {
        componentType: 'rest',
        config: { request: { uri: 'https://example.com/v3', method: 'GET' } },
        version: v1.version, // stale version
      })).rejects.toThrow(ConflictError);
    });

    it('ConflictError includes expected and current versions', async () => {
      const v1 = await repo.create({
        service: 'test-svc',
        action: 'error-details-test',
        componentType: 'rest',
        config: { request: { uri: 'https://example.com', method: 'GET' } },
      });

      // Update to version 2
      await repo.update('test-svc', 'error-details-test', {
        componentType: 'rest',
        config: { request: { uri: 'https://example.com/v2', method: 'GET' } },
        version: v1.version,
      });

      // Try to update with stale version
      try {
        await repo.update('test-svc', 'error-details-test', {
          componentType: 'rest',
          config: { request: { uri: 'https://example.com/v3', method: 'GET' } },
          version: v1.version, // stale version (1)
        });
        throw new Error('Should have thrown ConflictError');
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictError);
        expect((error as ConflictError).details).toEqual({
          expected: 1,
          current: 2,
        });
      }
    });

    it('POST duplicate throws ConflictError (not upsert)', async () => {
      await repo.create({
        service: 'test-svc',
        action: 'dup-test',
        componentType: 'rest',
        config: { request: { uri: 'https://example.com', method: 'GET' } },
      });

      expect(repo.create({
        service: 'test-svc',
        action: 'dup-test',
        componentType: 'rest',
        config: { request: { uri: 'https://example.com/v2', method: 'GET' } },
      })).rejects.toThrow(ConflictError);
    });
  });

  describe('Workflow versioning', () => {
    it('starts with version 1 on creation', async () => {
      const wf = await db.saveWorkflow({
        id: generateId(),
        name: 'test-workflow',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(wf.version).toBe(1);
    });

    it('increments version on update', async () => {
      const v1 = await db.saveWorkflow({
        id: generateId(),
        name: 'version-test-wf',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const v2 = await db.updateWorkflow(v1.id, {
        name: 'version-test-wf-updated',
        version: v1.version,
      });
      expect(v2.version).toBe(2);

      const v3 = await db.updateWorkflow(v2.id, {
        description: 'Added description',
        version: v2.version,
      });
      expect(v3.version).toBe(3);
    });
  });
});
