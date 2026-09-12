import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';
import { DbComponentRepository } from '@/core/db/repositories/component.repository.js';
import type { DBAdapter } from '@/core/db/adapter.js';

const request = (service: string, action: string, extra: Record<string, unknown> = {}) => ({
  service,
  action,
  componentType: 'rest',
  config: { uri: 'https://x.test', method: 'POST' },
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

  it('inserts on first upsert', async () => {
    const { record, created } = await repo.register(request('customer-service', 'create_customer'));
    expect(created).toBe(true);
    expect(record.id).toBeTruthy();
    expect(record.service).toBe('customer-service');
    expect(record.createdAt).toBe(record.updatedAt);
  });

  it('updates in place on second upsert — same id, no duplicate row', async () => {
    const { record: first } = await repo.register(request('svc', 'act'));
    const { record: second, created } = await repo.register(request('svc', 'act', {
      config: { uri: 'https://changed.test', method: 'GET' },
    }));
    expect(created).toBe(false);

    expect(second.id).toBe(first.id);
    expect(second.config.uri).toBe('https://changed.test');
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.createdAt));

    const page = await repo.list({}, 50, 0);
    expect(page.total).toBe(1);
  });

  it('clears an omitted field, because POST is a full replace', async () => {
    await repo.register(request('svc', 'act', { condition: '$.context.flag == true' }));
    const { record: updated } = await repo.register(request('svc', 'act'));
    expect(updated.condition).toBeUndefined();
  });

  it('recovers when it loses the insert race, updating instead of throwing', async () => {
    let firstCall = true;
    const racy = new DbComponentRepository({
      ...db,
      saveComponent: async (record) => {
        if (!firstCall) return db.saveComponent(record);
        firstCall = false;
        await db.saveComponent({ ...record, id: 'winner' });
        throw new Error('UNIQUE constraint failed: component_definitions.service, component_definitions.action');
      },
    });

    const { record, created } = await racy.register(request('svc', 'act', {
      config: { uri: 'https://retried.test', method: 'GET' },
    }));

    expect(created).toBe(false);
    expect(record.id).toBe('winner');
    expect(record.config.uri).toBe('https://retried.test');
    expect((await racy.list({}, 50, 0)).total).toBe(1);
  });

  it('rethrows a non-unique-violation error rather than retrying', async () => {
    const broken = new DbComponentRepository({
      ...db,
      saveComponent: async () => { throw new Error('disk I/O error'); },
    });

    await expect(broken.register(request('svc', 'act'))).rejects.toThrow('disk I/O error');
  });

  it('deleting an already-deleted id is a no-op, not an error', async () => {
    const { record } = await repo.register(request('svc', 'act'));
    await repo.delete(record.id);
    await expect(repo.delete(record.id)).resolves.toBeUndefined();
  });

  it('treats the same action under a different service as a distinct record', async () => {
    await repo.register(request('svc-a', 'act'));
    await repo.register(request('svc-b', 'act'));
    expect((await repo.list({}, 50, 0)).total).toBe(2);
  });

  it('finds by natural key and returns null for a miss', async () => {
    await repo.register(request('svc', 'act'));
    expect(await repo.findByKey('svc', 'act')).not.toBeNull();
    expect(await repo.findByKey('svc', 'nope')).toBeNull();
  });

  it('lists all actions of one service', async () => {
    await repo.register(request('svc', 'a'));
    await repo.register(request('svc', 'b'));
    await repo.register(request('other', 'c'));

    const actions = await repo.listByService('svc');
    expect(actions.map((a) => a.action).sort()).toEqual(['a', 'b']);
  });

  it('returns an empty array for an unknown service', async () => {
    expect(await repo.listByService('ghost')).toEqual([]);
  });

  it('reports the filtered total, not the page length', async () => {
    for (let i = 0; i < 7; i++) await repo.register(request('svc', `act_${i}`));

    const page = await repo.list({}, 2, 0);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(7);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(0);
  });

  it('applies offset', async () => {
    for (let i = 0; i < 5; i++) await repo.register(request('svc', `act_${i}`));
    const page = await repo.list({}, 2, 4);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(5);
  });

  it('applies the same filters to items and total', async () => {
    await repo.register(request('svc-a', 'a'));
    await repo.register(request('svc-a', 'b'));
    await repo.register(request('svc-b', 'c'));

    const page = await repo.list({ service: 'svc-a' }, 50, 0);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  it('filters by componentType', async () => {
    await repo.register(request('svc', 'a'));
    await repo.register({ ...request('svc', 'b'), componentType: 'mapper' });

    const page = await repo.list({ componentType: 'mapper' }, 50, 0);
    expect(page.total).toBe(1);
    expect(page.items[0].action).toBe('b');
  });

  it('deletes by id', async () => {
    const { record } = await repo.register({
      service: 'svc',
      action: 'act',
      componentType: 'rest',
      config: { uri: 'https://x.test', method: 'POST' },
    });
    await repo.delete(record.id);
    expect(await repo.findByKey('svc', 'act')).toBeNull();
  });

  it('stores an $env. reference verbatim — masking is a display concern', async () => {
    const { record } = await repo.register({
      service: 'svc',
      action: 'act',
      componentType: 'rest',
      config: { uri: 'https://x.test', method: 'POST', auth: { basic: { username: 'u', password: '$env.PW' } } },
    });
    const reread = await repo.findByKey('svc', 'act');
    expect((reread!.config as any).auth.basic.password).toBe('$env.PW');
    expect((record.config as any).auth.basic.password).toBe('$env.PW');
  });
});
