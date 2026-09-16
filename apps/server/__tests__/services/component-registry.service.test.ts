import { describe, it, expect, beforeEach } from 'bun:test';
import { ComponentRegistryService } from '@/services/component-registry.service.js';
import type { ComponentRepository, RegisterOutcome } from '@/core/db/repositories/component.repository.js';
import { createCoreSchemaRegistry } from '@/core/schema/index.js';
import type { ComponentRecord } from '@/core/db/adapter.js';
import type { ListFilters, PagedResult, RegisterServiceRequest } from '@/core/types.js';
import { AppError } from '@/lib/index.js';

class FakeComponentRepository implements ComponentRepository {
  readonly rows = new Map<string, ComponentRecord>();
  private seq = 0;

  private key(service: string, action: string) { return `${service}/${action}`; }

  async register(request: RegisterServiceRequest): Promise<RegisterOutcome> {
    const k = this.key(request.service, request.action);
    const now = new Date().toISOString();
    const existing = this.rows.get(k);
    const record: ComponentRecord = {
      id: existing?.id ?? `id-${++this.seq}`,
      service: request.service,
      action: request.action,
      componentType: request.componentType,
      description: request.description,
      config: request.config,
      condition: request.condition,
      metaData: request.metaData,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(k, record);
    return { record, created: !existing };
  }

  async findByKey(service: string, action: string) {
    return this.rows.get(this.key(service, action)) ?? null;
  }

  async listByService(service: string) {
    return [...this.rows.values()].filter((r) => r.service === service);
  }

  async list(filters: ListFilters, limit: number, offset: number): Promise<PagedResult<ComponentRecord>> {
    const all = [...this.rows.values()].filter((r) =>
      (!filters.service || r.service === filters.service) &&
      (!filters.componentType || r.componentType === filters.componentType));
    return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
  }

  async delete(id: string) {
    for (const [k, v] of this.rows) if (v.id === id) this.rows.delete(k);
  }
}

const validBody = {
  service: 'customer-service',
  action: 'create_customer',
  componentType: 'rest',
  config: { request: { uri: 'https://api.example.com/customers', method: 'POST' } },
};

async function expectAppError(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected an AppError to be thrown');
}

describe('ComponentRegistryService', () => {
  let repo: FakeComponentRepository;
  let service: ComponentRegistryService;

  beforeEach(() => {
    repo = new FakeComponentRepository();
    service = new ComponentRegistryService(repo, createCoreSchemaRegistry());
  });

  describe('register — stage 1, envelope', () => {
    it('accepts a valid body', async () => {
      const { record } = await service.register(validBody);
      expect(record.service).toBe('customer-service');
      expect(record.componentType).toBe('rest');
    });

    it('rejects a null body rather than throwing a raw error', async () => {
      const err = await expectAppError(() => service.register(null));
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a non-URL-safe service name', async () => {
      const err = await expectAppError(() => service.register({ ...validBody, service: 'bad name/x' }));
      expect(err.code).toBe('VALIDATION_FAILED');
    });

    it('rejects an empty condition, which is a config error not "no condition"', async () => {
      const err = await expectAppError(() => service.register({ ...validBody, condition: '' }));
      expect(err.code).toBe('VALIDATION_FAILED');
    });

    it('accepts an omitted condition', async () => {
      const { record } = await service.register(validBody);
      expect(record.condition).toBeUndefined();
    });

    it('rejects unknown top-level keys', async () => {
      const err = await expectAppError(() => service.register({ ...validBody, rogue: true }));
      expect(err.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('register — stage 2, componentType dispatch', () => {
    it('rejects an unregistered componentType with a distinct code and the supported list', async () => {
      const err = await expectAppError(() =>
        service.register({ ...validBody, componentType: 'carrier-pigeon' }));
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('UNKNOWN_COMPONENT_TYPE');
      const details = err.details as Record<string, unknown>;
      expect(details.supported).toEqual(['rest']);
    });

    it('rejects a config that fails the type-specific schema', async () => {
      const err = await expectAppError(() =>
        service.register({ ...validBody, config: { request: { method: 'POST' } } }));
      expect(err.code).toBe('VALIDATION_FAILED');
    });

    it('prefixes config issue paths with "config"', async () => {
      const err = await expectAppError(() =>
        service.register({ ...validBody, config: { request: { method: 'POST' } } }));
      const issues = err.details as Array<{ path: string[] }>;
      expect(issues[0].path[0]).toBe('config');
      expect(issues[0].path).toContain('uri');
    });

    it('accepts a plugin type once its schema is registered', async () => {
      const { z } = await import('zod');
      const registry = createCoreSchemaRegistry().register('acme', z.object({ tenant: z.string() }).strict());
      const pluginService = new ComponentRegistryService(repo, registry);

      const { record } = await pluginService.register({
        service: 'acme-service', action: 'sync', componentType: 'acme', config: { tenant: 't1' },
      });
      expect(record.componentType).toBe('acme');
    });
  });

  describe('register — stage 3, {$env.} references', () => {
    it('accepts a well-formed reference and stores it verbatim', async () => {
      const { record } = await service.register({
        ...validBody,
        config: { request: { ...validBody.config.request, auth: { basic: { username: 'u', password: '{$env.CRM_PW}' } } } },
      });
      expect((record.config as any).request.auth.basic.password).toBe('{$env.CRM_PW}');
    });

    it('rejects a malformed reference instead of storing it as a literal', async () => {
      const err = await expectAppError(() => service.register({
        ...validBody,
        config: { request: { ...validBody.config.request, auth: { basic: { username: 'u', password: '{$env.}' } } } },
      }));
      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.message).toContain('{$env.}');
    });

    it('accepts a literal secret without complaint — that is the policy', async () => {
      const { record } = await service.register({
        ...validBody,
        config: { request: { ...validBody.config.request, auth: { basic: { username: 'u', password: 'hunter2' } } } },
      });
      expect((record.config as any).request.auth.basic.password).toBe('hunter2');
    });
  });

  describe('register — upsert', () => {
    it('is idempotent on the natural key', async () => {
      const { record: first } = await service.register(validBody);
      const { record: second, created } = await service.register({ ...validBody, description: 'updated' });
      expect(created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(second.description).toBe('updated');
      expect(repo.rows.size).toBe(1);
    });
  });

  describe('reads', () => {
    it('gets by natural key', async () => {
      await service.register(validBody);
      const record = await service.get('customer-service', 'create_customer');
      expect(record.action).toBe('create_customer');
    });

    it('throws 404 with the natural key in the message', async () => {
      const err = await expectAppError(() => service.get('ghost', 'act'));
      expect(err.statusCode).toBe(404);
      expect(err.message).toBe('Service not found: ghost/act');
    });

    it('returns an empty array for an unknown service rather than 404', async () => {
      expect(await service.listByService('ghost')).toEqual([]);
    });

    it('passes paging through and reports the real total', async () => {
      for (let i = 0; i < 5; i++) {
        await service.register({ ...validBody, action: `act_${i}` });
      }
      const page = await service.list({}, 2, 0);
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(5);
    });
  });

  describe('remove', () => {
    it('deletes an existing component', async () => {
      await service.register(validBody);
      await service.remove('customer-service', 'create_customer');
      expect(await repo.findByKey('customer-service', 'create_customer')).toBeNull();
    });

    it('is idempotent — silently succeeds for a missing component', async () => {
      await expect(service.remove('ghost', 'act')).resolves.toBeUndefined();
    });
  });
});
