/**
 * Phase 1 domain types. Sourced from plans/core-types.md.
 * Only the types Phase 1 uses are transcribed; the rest arrive with their phase.
 */

export type ComponentType =
  | 'rest' | 'script' | 'mapper' | 'sqs' | 'sns' | 's3' | 'redis' | 'rabbitmq' | 'solace'
  | 'kafka' | 'database' | 'scheduler';

/**
 * Accepts any known ComponentType with autocomplete, plus any plugin-registered custom
 * type. The `& {}` preserves the literal-union autocomplete that a bare `| string` would
 * destroy. Required so third-party component types can be registered without recompiling
 * the core (see validation.md), and assignment-compatible with the shipped
 * `ComponentRecord.componentType: string` in core/db/adapter.ts.
 */
export type KnownOrCustomComponentType = ComponentType | (string & {});

/** Registration request body. `config` is validated separately, per componentType. */
export interface RegisterServiceRequest<TConfig = Record<string, unknown>> {
  service: string;
  action: string;
  componentType: KnownOrCustomComponentType;
  description?: string;
  config: TConfig;
  /** Record-level, not config-level — sibling of `config`, matching ComponentRecord. */
  condition?: string;
  metaData?: Record<string, unknown>;
}

/** What the API returns. Identical to ComponentRecord — masking does not change shape. */
export interface ComponentView {
  id: string;
  service: string;
  action: string;
  componentType: KnownOrCustomComponentType;
  description?: string;
  config: Record<string, unknown>;
  condition?: string;
  metaData?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Repository paging result. `total` is the count matching the filters, ignoring paging. */
export interface PagedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListFilters {
  service?: string;
  componentType?: string;
}
