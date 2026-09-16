import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';
import { DbComponentRepository } from '@/core/db/repositories/component.repository.js';
import type { DBAdapter } from '@/core/db/adapter.js';
import { ConflictError } from '@/lib/index.js';

const createRequest = (service: string, action: string, extra: Record<string, unknown> = {}) => ({
  service,
  action,
  componentType: 'rest',
  config: { request: { uri: 'https://x.test', method: 'POST' } },
  ...extra,
});

describe('DbComponentRepository', () => {
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

  it('inserts on create', async () => {
    const record = await repo.create(createRequest('customer-service', 'create_customer'));
    expect(record.id).toBeTruthy();
    expect(record.service).toBe('customer-service');
    expect(record.version).toBe(1);
    expect(record.createdAt).toBe(record.updatedAt);
  });

  it('throws ConflictError when creating a duplicate', async () => {
    await repo.create(createRequest('svc', 'act'));
    expect(repo.create(createRequest('svc', 'act'))).rejects.toThrow(ConflictError);
  });

  it('updates in place — same id, version increments', async () => {
    const first = await repo.create(createRequest('svc', 'act'));
    const second = await repo.update('svc', 'act', {
      componentType: 'rest',
      config: { request: { uri: 'https://changed.test', method: 'GET' } },
      version: first.version,
    });

    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(second.config.request).toEqual({ uri: 'https://changed.test', method: 'GET' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.createdAt));

    const page = await repo.list({}, 50, 0);
    expect(page.total).toBe(1);
  });

  it('clears an omitted field, because PUT is a full replace', async () => {
    await repo.create(createRequest('svc', 'act', { condition: '$.context.flag == true' }));
    const updated = await repo.update('svc', 'act', {
      componentType: 'rest',
      config: { request: { uri: 'https://x.test', method: 'POST' } },
      version: 1,
    });
    expect(updated.condition).toBeUndefined();
  });

  it('throws NotFoundError when updating a non-existent component', async () => {
    expect(repo.update('ghost', 'act', {
      componentType: 'rest',
      config: {},
      version: 1,
    })).rejects.toThrow('Service not found: ghost/act');
  });

  it('throws ConflictError on version mismatch', async () => {
    await repo.create(createRequest('svc', 'act'));
    expect(repo.update('svc', 'act', {
      componentType: 'rest',
      config: { request: { uri: 'https://x.test', method: 'POST' } },
      version: 999,
    })).rejects.toThrow(ConflictError);
  });

  it('rethrows a non-unique-violation error on create', async () => {
    const broken = new DbComponentRepository({
      ...db,
      saveComponent: async () => { throw new Error('disk I/O error'); },
    });

    await expect(broken.create(createRequest('svc', 'act'))).rejects.toThrow('disk I/O error');
  });

  it('deleting an already-deleted id is a no-op, not an error', async () => {
    const record = await repo.create(createRequest('svc', 'act'));
    await repo.delete(record.id);
    await expect(repo.delete(record.id)).resolves.toBeUndefined();
  });

  it('treats the same action under a different service as a distinct record', async () => {
    await repo.create(createRequest('svc-a', 'act'));
    await repo.create(createRequest('svc-b', 'act'));
    expect((await repo.list({}, 50, 0)).total).toBe(2);
  });

  it('finds by natural key and returns null for a miss', async () => {
    await repo.create(createRequest('svc', 'act'));
    expect(await repo.findByKey('svc', 'act')).not.toBeNull();
    expect(await repo.findByKey('svc', 'nope')).toBeNull();
  });

  it('lists all actions of one service', async () => {
    await repo.create(createRequest('svc', 'a'));
    await repo.create(createRequest('svc', 'b'));
    await repo.create(createRequest('other', 'c'));

    const actions = await repo.listByService('svc');
    expect(actions.map((a) => a.action).sort()).toEqual(['a', 'b']);
  });

  it('returns an empty array for an unknown service', async () => {
    expect(await repo.listByService('ghost')).toEqual([]);
  });

  it('reports the filtered total, not the page length', async () => {
    for (let i = 0; i < 7; i++) await repo.create(createRequest('svc', `act_${i}`));

    const page = await repo.list({}, 2, 0);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(7);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(0);
  });

  it('applies offset', async () => {
    for (let i = 0; i < 5; i++) await repo.create(createRequest('svc', `act_${i}`));
    const page = await repo.list({}, 2, 4);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(5);
  });

  it('applies the same filters to items and total', async () => {
    await repo.create(createRequest('svc-a', 'a'));
    await repo.create(createRequest('svc-a', 'b'));
    await repo.create(createRequest('svc-b', 'c'));

    const page = await repo.list({ service: 'svc-a' }, 50, 0);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  it('filters by componentType', async () => {
    await repo.create(createRequest('svc', 'a'));
    await repo.create({ ...createRequest('svc', 'b'), componentType: 'mapper' });

    const page = await repo.list({ componentType: 'mapper' }, 50, 0);
    expect(page.total).toBe(1);
    expect(page.items[0].action).toBe('b');
  });

  it('deletes by id', async () => {
    const record = await repo.create({
      service: 'svc',
      action: 'act',
      componentType: 'rest',
      config: { request: { uri: 'https://x.test', method: 'POST' } },
    });
    await repo.delete(record.id);
    expect(await repo.findByKey('svc', 'act')).toBeNull();
  });

  it('stores an $env. reference verbatim — masking is a display concern', async () => {
    const record = await repo.create({
      service: 'svc',
      action: 'act',
      componentType: 'rest',
      config: { request: { uri: 'https://x.test', method: 'POST', auth: { basic: { username: 'u', password: '$env.PW' } } } },
    });
    const reread = await repo.findByKey('svc', 'act');
    expect((reread!.config as any).request.auth.basic.password).toBe('$env.PW');
    expect((record.config as any).request.auth.basic.password).toBe('$env.PW');
  });
});
