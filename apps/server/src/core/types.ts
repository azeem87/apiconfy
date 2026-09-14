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

export interface InvocationRequest {
  context: Record<string, unknown>;
}

export interface StandardError {
  error: {
    code: string;
    message: string;
    details?: Array<{ rule: string; message: string; path: string }>;
    downstream?: { status?: number; body?: unknown };
  };
}

export interface InvocationResult {
  success: boolean;
  data: unknown;
  skippedExecution?: boolean;
  meta: { executionId: string; durationMs: number };
}

/** Wire contract for the invoke route's catch-all failure envelope (HTTP-level, not the
 * in-band `StandardError` injected into `data` by the response pipeline). */
export interface InvocationFailure {
  success: false;
  data: null;
  error: { code: string; message: string; details?: unknown };
  meta: { executionId: string; durationMs: number };
}

export type ExecutionType = 'saga' | 'service';
export type ExecutionStatus =
  | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'COMPENSATING' | 'COMPENSATED' | 'STUCK';

export interface ExecutionStep {
  name: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED'
    | 'COMPENSATING' | 'COMPENSATED' | 'COMPENSATION_FAILED' | 'VERIFYING';
  startedAt?: string;
  completedAt?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
  attempts?: number;
}

export interface TimeoutConfig {
  connect?: number;
  socket?: number;
  response?: number;
  idle?: number;
}

export interface RateLimitConfig {
  requests: number;
  windowMs: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  windowSize: number;
  openDuration: number;
  halfOpenMaxAttempts: number;
}

export interface ResilienceConfig {
  retryCount?: number;
  retryDelay?: number;
  backoff?: 'fixed' | 'exponential';
  maxDelay?: number;
  retryOn?: number[];
  rateLimit?: RateLimitConfig;
  circuitBreaker?: CircuitBreakerConfig;
}

export interface ValidationRule {
  expression: string;
  message?: string;
  errorPath?: string;
}

export interface ResponseConfig {
  transformation?: Record<string, unknown>;
  validation?: { rules?: ValidationRule[] };
  default?: Record<string, unknown>;
}

export interface SSLConfig {
  cert: string;
  key: string;
  ca?: string;
  passphrase?: string;
}

export interface RequestConfig {
  uri: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  contentType?: string;
  disableSSL?: boolean;
  ssl?: SSLConfig;
  headers?: Record<string, string>;
  payloadTemplate?: Record<string, unknown>;
  /** Phase 2 refuses auth; Phase 4 owns its executable contract. */
  auth?: Record<string, unknown>;
}

export interface RestConfig {
  request: RequestConfig;
  timeout?: TimeoutConfig;
  resilience?: ResilienceConfig;
  response?: ResponseConfig;
}
