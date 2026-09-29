import type { ComponentExecuteParams, ComponentExecuteResult, ComponentHandler } from '@/core/components/base.js';
import {
  ScriptEvaluationError, WorkerScriptEvaluator, type ScriptEvaluator,
} from '@/core/runtime/script-evaluator.js';
import { unavailableScriptBridge, type ScriptHostBridge } from '@/core/runtime/script-bridge.js';
import type { ScriptConfig } from '@/core/types.js';
import { ScriptError, TimeoutError } from '@/lib/errors.js';

/**
 * Phase 3.5 — evaluates operator JS locally. The script's contribution (the `$context` variables
 * it changed) becomes the handler's `data` (script-component.md D5 — `return` values are ignored).
 * The deadline comes from the runtime's resilience executor, which aborts `signal`.
 */
export class ScriptComponent implements ComponentHandler {
  readonly componentType = 'script';
  readonly displayName = 'Script (JS)';

  constructor(
    private readonly evaluator: ScriptEvaluator = new WorkerScriptEvaluator(),
    private readonly bridge: ScriptHostBridge = unavailableScriptBridge(),
  ) {}

  async execute({ config, context, signal, executionId }: ComponentExecuteParams): Promise<ComponentExecuteResult> {
    const script = config as unknown as ScriptConfig;
    try {
      const data = await this.evaluator.evaluate({
        expression: script.expression,
        context: context.context,
        signal,
        executionId,
        bridge: this.bridge,
      });
      return { data };
    } catch (error) {
      if (!(error instanceof ScriptEvaluationError)) throw error;
      if (error.reason === 'deadline') throw new TimeoutError();
      // The reason travels in the message and therefore into the execution record (§D10).
      throw new ScriptError(error.reason);
    }
  }
}
