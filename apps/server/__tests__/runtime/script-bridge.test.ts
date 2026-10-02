import { describe, it, expect } from 'bun:test';
import {
  createScriptHostBridge, unavailableScriptBridge, type ScriptBridgeDeps,
} from '@/core/runtime/script-bridge.js';
import type { InvokeParams, RuntimeExecutor } from '@/core/runtime/index.js';
import { createLogger, NotFoundError } from '@/lib/index.js';

const logger = createLogger('test', 'silent');

interface Captured { params: InvokeParams }

function buildBridge(options: {
  invoke?: (params: InvokeParams) => Promise<unknown>;
  deps?: Partial<ScriptBridgeDeps>;
  captured?: Captured;
} = {}) {
  const captured: Captured = options.captured ?? { params: undefined as unknown as InvokeParams };
  const runtime: RuntimeExecutor = {
    async invoke(params) {
      captured.params = params;
      if (options.invoke) return await options.invoke(params) as never;
      return {
        success: true, data: { echoed: params.service },
        meta: { executionId: params.executionId, durationMs: 5 },
      } as never;
    },
  };
  const bridge = createScriptHostBridge({
    runtime: () => runtime,
    logger,
    ...options.deps,
  });
  return { bridge, captured };
}

describe('createScriptHostBridge', () => {
  it('runs a nested invoke through the executor and returns the success envelope', async () => {
    const { bridge, captured } = buildBridge();
    const result = await bridge.invoke({ service: 'items', action: 'create', context: { id: 7 } });

    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ echoed: 'items' });
    expect(result).not.toHaveProperty('meta');
    // The executor received the caller's context verbatim.
    expect(captured.params.context).toEqual({ id: 7 });
    expect(captured.params.service).toBe('items');
    expect(captured.params.action).toBe('create');
  });

  it('maps an AppError to the failure envelope with code, message and details kept', async () => {
    const { bridge } = buildBridge({
      invoke: async () => { throw new NotFoundError('Service not found: x/y'); },
    });
    const result = await bridge.invoke({ service: 'x', action: 'y', context: {} });

    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect((result as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect((result as { error: { message: string } }).error.message).toBe('Service not found: x/y');
    expect(result).not.toHaveProperty('meta');
  });

  it('maps a non-AppError throw to INTERNAL_ERROR', async () => {
    const { bridge } = buildBridge({ invoke: async () => { throw new Error('raw'); } });
    const result = await bridge.invoke({ service: 'x', action: 'y', context: {} });

    expect(result.success).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });

  it('reports INTERNAL_ERROR when the runtime thunk is uninitialized', async () => {
    const bridge = createScriptHostBridge({
      runtime: () => { throw new Error('runtime executor used before initialization'); },
      logger,
    });
    const result = await bridge.invoke({ service: 'x', action: 'y', context: {} });

    expect(result.success).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });

  it('reports NOT_IMPLEMENTED for executeWorkflow until the Phase 5 orchestrator is wired', async () => {
    const { bridge } = buildBridge();
    const result = await bridge.executeWorkflow({ workflowName: 'onboarding', context: {} });

    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect((result as { error: { code: string } }).error.code).toBe('NOT_IMPLEMENTED');
    expect(result.meta.workflowName).toBe('onboarding');
  });

  it('reports NOT_IMPLEMENTED for generate until the $gen.* registry ships', async () => {
    const { bridge } = buildBridge();
    const result = await bridge.generate({ name: 'clientTransactionId' });

    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect((result as { error: { code: string } }).error.code).toBe('NOT_IMPLEMENTED');
  });
});

describe('unavailableScriptBridge', () => {
  it('reports NOT_IMPLEMENTED for all three methods', async () => {
    const bridge = unavailableScriptBridge();
    const invoked = await bridge.invoke({ service: 'x', action: 'y', context: {} });
    const workflow = await bridge.executeWorkflow({ workflowName: 'wf', context: {} });
    const generated = await bridge.generate({ name: 'uuid' });

    expect((invoked as { error: { code: string } }).error.code).toBe('NOT_IMPLEMENTED');
    expect((workflow as { error: { code: string } }).error.code).toBe('NOT_IMPLEMENTED');
    expect((generated as { error: { code: string } }).error.code).toBe('NOT_IMPLEMENTED');
  });
});
