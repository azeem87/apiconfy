import type { ExecutionContext } from '@/core/runtime/types.js';
import type { ValidationField } from '@/core/types.js';

export interface ComponentHandler {
  readonly componentType: string;
  /** Human-readable label for future admin/UI surfaces; not read by the runtime today. */
  readonly displayName?: string;
  assertExecutable?(config: Record<string, unknown>): void;
  /** Declares payload field constraints from this component's config; the runtime validates them before dispatch. */
  validationFields?(config: Record<string, unknown>): ValidationField[];
  execute(params: ComponentExecuteParams): Promise<ComponentExecuteResult>;
}

export interface ComponentExecuteParams {
  config: Record<string, unknown>;
  context: ExecutionContext;
  signal: AbortSignal;
  executionId: string;
  /** Capture a header-free audit summary even when transport fails. */
  onRequest?(request: ComponentRequestSummary): void;
  /** Register an acquired credential (e.g. a token) for scrubbing before it can reach a log or audit row. */
  onSecret?(secret: string): void;
}

export interface ComponentRequestSummary {
  uri: string;
  method: string;
  body?: unknown;
}

export interface ComponentExecuteResult {
  /** Raw result from the external operation. Only set on success — component errors throw. */
  data: unknown;
  request?: ComponentRequestSummary;
}
