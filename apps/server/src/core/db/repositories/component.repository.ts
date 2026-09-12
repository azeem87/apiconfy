import type { DBAdapter, ComponentRecord } from '@/core/db/adapter.js';
import type { ListFilters, PagedResult, RegisterServiceRequest } from '@/core/types.js';
import { generateId } from '@/lib/index.js';

export interface RegisterOutcome {
  record: ComponentRecord;
  created: boolean;
}

export interface ComponentRepository {
  register(request: RegisterServiceRequest): Promise<RegisterOutcome>;
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

  async register(request: RegisterServiceRequest): Promise<RegisterOutcome> {
    const existing = await this.db.findComponent(request.service, request.action);
    if (existing) return { record: await this.applyUpdate(existing.id, request), created: false };

    const timestamp = new Date().toISOString();
    try {
      const record = await this.db.saveComponent({
        id: generateId(),
        service: request.service,
        action: request.action,
        componentType: request.componentType,
        description: request.description,
        config: request.config,
        condition: request.condition,
        metaData: request.metaData,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return { record, created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;

      const winner = await this.db.findComponent(request.service, request.action);
      if (!winner) throw err;
      return { record: await this.applyUpdate(winner.id, request), created: false };
    }
  }

  private applyUpdate(id: string, request: RegisterServiceRequest): Promise<ComponentRecord> {
    return this.db.updateComponent(id, {
      componentType: request.componentType,
      description: request.description,
      config: request.config,
      condition: request.condition,
      metaData: request.metaData,
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
