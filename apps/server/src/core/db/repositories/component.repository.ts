import type { DBAdapter, ComponentRecord } from '@/core/db/adapter.js';
import type { ListFilters, PagedResult, RegisterServiceRequest, UpdateServiceRequest } from '@/core/types.js';
import { generateId, ConflictError, NotFoundError } from '@/lib/index.js';

export interface ComponentRepository {
  create(request: RegisterServiceRequest): Promise<ComponentRecord>;
  update(service: string, action: string, request: UpdateServiceRequest): Promise<ComponentRecord>;
  findByKey(service: string, action: string): Promise<ComponentRecord | null>;
  listByService(service: string): Promise<ComponentRecord[]>;
  list(filters: ListFilters, limit: number, offset: number): Promise<PagedResult<ComponentRecord>>;
  delete(id: string): Promise<void>;
}

const SERVICE_ACTION_CEILING = 1000;

function isUniqueViolation(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === '23505') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|duplicate key value/i.test(message);
}

export class DbComponentRepository implements ComponentRepository {
  constructor(private readonly db: DBAdapter) {}

  async create(request: RegisterServiceRequest): Promise<ComponentRecord> {
    const timestamp = new Date().toISOString();
    try {
      return await this.db.saveComponent({
        id: generateId(),
        service: request.service,
        action: request.action,
        componentType: request.componentType,
        description: request.description,
        config: request.config,
        condition: request.condition,
        metaData: request.metaData,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new ConflictError(
        `Service already exists: ${request.service}/${request.action}`,
        { service: request.service, action: request.action }
      );
    }
  }

  async update(service: string, action: string, request: UpdateServiceRequest): Promise<ComponentRecord> {
    const existing = await this.db.findComponent(service, action);
    if (!existing) {
      throw new NotFoundError(`Service not found: ${service}/${action}`);
    }

    if (request.version !== existing.version) {
      throw new ConflictError(
        `Version conflict: expected ${request.version}, but current version is ${existing.version}`,
        { expected: request.version, current: existing.version }
      );
    }

    return this.db.updateComponent(existing.id, {
      componentType: request.componentType,
      description: request.description,
      config: request.config,
      condition: request.condition,
      metaData: request.metaData,
      version: existing.version,
    });
  }

  findByKey(service: string, action: string): Promise<ComponentRecord | null> {
    return this.db.findComponent(service, action);
  }

  listByService(service: string): Promise<ComponentRecord[]> {
    return this.db.listComponents({ service }, SERVICE_ACTION_CEILING, 0);
  }

  async list(filters: ListFilters, limit: number, offset: number): Promise<PagedResult<ComponentRecord>> {
    const [items, total] = await Promise.all([
      this.db.listComponents(filters, limit, offset),
      this.db.countComponents(filters),
    ]);
    return { items, total, limit, offset };
  }

  delete(id: string): Promise<void> {
    return this.db.deleteComponent(id);
  }
}
