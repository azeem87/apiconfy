import type { ComponentRecord } from '@/core/db/adapter.js';
import type { ComponentRequestSummary } from '@/core/components/base.js';
import type { ExecutionStatus } from '@/core/types.js';
import type { ExpressionScope } from '@/core/transform/index.js';

export type ExecutionContext = ExpressionScope;

export interface InvokeParams {
  service: string;
  action: string;
  context: Record<string, unknown>;
  executionId: string;
  startedAtMs: number;
}

export interface ComponentLookup {
  findByKey(service: string, action: string): Promise<ComponentRecord | null>;
}

export interface InvocationRecord {
  executionId: string;
  service: string;
  action: string;
  componentType: string;
  status: Extract<ExecutionStatus, 'COMPLETED' | 'FAILED'>;
  logStatus: 'success' | 'failed' | 'skipped';
  context: Record<string, unknown>;
  result: unknown;
  attempts: number;
  error?: { code: string; message: string; details?: unknown };
  durationMs: number;
  startedAt: string;
  completedAt: string;
  request?: ComponentRequestSummary;
  response?: unknown;
}

export interface ExecutionRecorder {
  recordInvocation(entry: InvocationRecord): Promise<void>;
}
