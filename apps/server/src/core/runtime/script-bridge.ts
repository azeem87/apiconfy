import type { InvocationFailure, InvocationResult } from '@/core/types.js';
import type { RuntimeExecutor } from '@/core/runtime/runtime-executor.js';
import { toInvocationFailure } from '@/lib/envelope.js';
import { generateId, type Logger } from '@/lib/index.js';

export interface ScriptInvokeRequest {
  service: string;
  action: string;
  context: Record<string, unknown>;
}

export interface ScriptWorkflowRequest {
  workflowName: string;
  context: Record<string, unknown>;
}

export interface ScriptGenerateRequest {
  name: string;
  params?: Record<string, unknown>;
}

/** Envelope family shared by every script bridge call — resolves, never throws (B2, §17). */
export type GeneratorResult =
  | { success: true; data: unknown }
  | { success: false; data: null; error: { code: string; message: string; details?: unknown } };

/** Phase 5 seam — the orchestrator's `execute()` contract (workflow-orchestrator.md). */
export interface WorkflowExecutor {
  execute(params: {
    workflowName: string;
    groupId?: string;
    context: Record<string, unknown>;
  }): Promise<unknown>;
}

/** Phase 5+ seam — the `$gen.*` registry (auto-generated-values.md). */
export interface GeneratorRegistry {
  generate(name: string, params?: Record<string, unknown>): Promise<unknown>;
}

export type WorkflowExecutionResult =
  | { success: true; data: unknown; meta: Record<string, unknown> }
  | {
      success: false; data: null;
      error: { code: string; message: string; details?: unknown };
      meta: Record<string, unknown>;
    };

/** Same slim shape as the invoke route's body — the execution id is not echoed to the script. */
export type ScriptInvokeResult =
  | Omit<InvocationResult, 'meta'>
  | Omit<InvocationFailure, 'meta'>;

export interface ScriptHostBridge {
  /**
   * Runs a nested invoke through the in-process executor. Every call is a first-class execution:
   * its own audit rows, retries/duration, retrievable via `GET /api/v1/executions/:executionId`.
   */
  invoke(request: ScriptInvokeRequest): Promise<ScriptInvokeResult>;
  /** Phase 5: returns NOT_IMPLEMENTED until `createApp` passes a `WorkflowExecutor` (§4.7 seam). */
  executeWorkflow(request: ScriptWorkflowRequest): Promise<WorkflowExecutionResult>;
  /** Phase 5+: returns NOT_IMPLEMENTED until the `$gen.*` registry ships (§4.7 seam). */
  generate(request: ScriptGenerateRequest): Promise<GeneratorResult>;
}

export interface ScriptBridgeDeps {
  /** Late-bound thunk — the executor owns the handler registry that hosts this bridge (§4.6). */
  runtime: () => RuntimeExecutor;
  logger: Logger;
  /** Absent today; wiring it flips `executeWorkflow` on with no script changes. */
  workflow?: WorkflowExecutor;
  /** Absent until the generators land; wiring it flips `generate` on with no script changes. */
  generators?: GeneratorRegistry;
}

const WORKFLOW_NOT_AVAILABLE = {
  success: false as const,
  data: null,
  error: {
    code: 'NOT_IMPLEMENTED',
    message: 'Workflow execution is not available in this build (Phase 5)',
  },
};

const GENERATORS_NOT_AVAILABLE = {
  success: false as const,
  data: null,
  error: {
    code: 'NOT_IMPLEMENTED',
    message: 'Utility generators are not available in this build ($gen.* ships Phase 5+)',
  },
};

export function createScriptHostBridge(deps: ScriptBridgeDeps): ScriptHostBridge {
  return {
    async invoke({ service, action, context }) {
      const executionId = generateId();
      const startedAtMs = Date.now();
      try {
        const { meta: _meta, ...result } = await deps.runtime().invoke({
          service, action, context, executionId, startedAtMs,
        });
        return result;
      } catch (caught) {
        deps.logger.warn({ executionId, service, action }, 'Script-initiated invoke failed');
        const { meta: _meta, ...failure } = toInvocationFailure(caught, executionId, startedAtMs);
        return failure;
      }
    },

    async executeWorkflow({ workflowName }) {
      if (!deps.workflow) {
        return { ...WORKFLOW_NOT_AVAILABLE, meta: { workflowName } };
      }
      // Phase 5: delegate to deps.workflow.execute({ workflowName, context }) and map to this
      // envelope — same shape as POST /api/v1/workflows/:workflowName/execute
      // (workflow-orchestrator.md → "Script-Initiated Workflow Execution (Phase 3.5 seam)").
      return { ...WORKFLOW_NOT_AVAILABLE, meta: { workflowName } };
    },

    async generate({ name }) {
      if (!deps.generators) {
        return GENERATORS_NOT_AVAILABLE;
      }
      // Phase 5+: delegate to the shared `$gen.*` registry (auto-generated-values.md).
      return {
        success: false, data: null,
        error: { code: 'NOT_IMPLEMENTED', message: `Generator not available: ${name}` },
      };
    },
  };
}

/** Safe default for direct construction/tests — every call reports NOT_IMPLEMENTED. */
export function unavailableScriptBridge(): ScriptHostBridge {
  const unavailable = { code: 'NOT_IMPLEMENTED', message: 'Script bridge is not wired in this build' };
  return {
    async invoke(): Promise<ScriptInvokeResult> {
      return { success: false, data: null, error: unavailable };
    },
    async executeWorkflow({ workflowName }): Promise<WorkflowExecutionResult> {
      return { success: false, data: null, error: unavailable, meta: { workflowName } };
    },
    async generate(): Promise<GeneratorResult> {
      return { success: false, data: null, error: unavailable };
    },
  };
}
