import type { ExecutionContext } from '@/core/runtime/types.js';

export interface ComponentHandler {
  readonly componentType: string;
  readonly displayName: string;
  assertExecutable?(config: Record<string, unknown>): void;
  execute(params: ComponentExecuteParams): Promise<ComponentExecuteResult>;
}

export interface ComponentExecuteParams {
  config: Record<string, unknown>;
  context: ExecutionContext;
  signal: AbortSignal;
  executionId: string;
  /** Capture a header-free audit summary even when transport fails. */
  onRequest?(request: ComponentRequestSummary): void;
}

export interface ComponentRequestSummary {
  uri: string;
  method: string;
  body?: unknown;
}

export interface ComponentExecuteResult {
  statusCode: number;
  data: unknown;
  request?: ComponentRequestSummary;
}
