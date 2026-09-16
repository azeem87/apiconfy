import type { z } from 'zod';
import type { ComponentRepository, RegisterOutcome } from '@/core/db/repositories/component.repository.js';
import type { SchemaRegistry } from '@/core/schema/index.js';
import { RegisterServiceRequestSchema } from '@/core/schema/index.js';
import { collectEnvRefIssues } from '@/core/env-ref/index.js';
import type {
  ComponentView, ListFilters, PagedResult, RegisterServiceRequest,
} from '@/core/types.js';
import { NotFoundError, UnknownComponentTypeError, ValidationError } from '@/lib/index.js';

export interface ComponentRegistry {
  register(body: unknown): Promise<RegisterOutcome>;
  list(filters: ListFilters, limit: number, offset: number): Promise<PagedResult<ComponentView>>;
  listByService(service: string): Promise<ComponentView[]>;
  get(service: string, action: string): Promise<ComponentView>;
  remove(service: string, action: string): Promise<void>;
}

function toIssues(error: z.ZodError): Array<{ path: (string | number)[]; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

export class ComponentRegistryService implements ComponentRegistry {
  constructor(
    private readonly repository: ComponentRepository,
    private readonly schemas: SchemaRegistry
  ) {}

  async register(body: unknown): Promise<RegisterOutcome> {
    const envelope = RegisterServiceRequestSchema.safeParse(body);
    if (!envelope.success) {
      throw new ValidationError('Invalid request body', toIssues(envelope.error));
    }
    const request = envelope.data;

    const configSchema = this.schemas.get(request.componentType);
    if (!configSchema) {
      throw new UnknownComponentTypeError(
        request.componentType,
        this.schemas.registeredTypes()
      );
    }

    const config = configSchema.safeParse(request.config);
    if (!config.success) {
      throw new ValidationError(
        'Invalid request body',
        toIssues(config.error).map((issue) => ({ ...issue, path: ['config', ...issue.path] }))
      );
    }

    const issues = collectEnvRefIssues(config.data, ['config']);
    if (issues.length > 0) {
      throw new ValidationError(
        'Invalid {$env.} reference',
        issues.map(({ path, message }) => ({ path, message }))
      );
    }

    return this.repository.register({
      ...request,
      config: config.data as Record<string, unknown>,
    } satisfies RegisterServiceRequest);
  }

  list(filters: ListFilters, limit: number, offset: number): Promise<PagedResult<ComponentView>> {
    return this.repository.list(filters, limit, offset);
  }

  listByService(service: string): Promise<ComponentView[]> {
    return this.repository.listByService(service);
  }

  async get(service: string, action: string): Promise<ComponentView> {
    const record = await this.repository.findByKey(service, action);
    if (!record) throw new NotFoundError(`Service not found: ${service}/${action}`);
    return record;
  }

  /**
   * Idempotent: a missing row is a no-op, not a 404. `deleted: true` means
   * "no such component exists now", so a retried DELETE after a timeout is safe.
   */
  async remove(service: string, action: string): Promise<void> {
    const record = await this.repository.findByKey(service, action);
    if (!record) return;
    await this.repository.delete(record.id);
  }
}
