import { RestComponent } from './rest/rest.component.js';
import { ScriptComponent } from './script/script.component.js';
import { ComponentHandlerRegistry } from '@/core/runtime/component-handler-registry.js';
import { WorkerScriptEvaluator } from '@/core/runtime/script-evaluator.js';
import { unavailableScriptBridge, type ScriptHostBridge } from '@/core/runtime/script-bridge.js';

/**
 * The handlers the server starts with. `scriptBridge` is wired by `createApp` (late-bound to the
 * runtime executor); without it the script component's bridge reports NOT_IMPLEMENTED.
 */
export function createCoreHandlerRegistry(
  httpRequest?: typeof fetch,
  scriptBridge?: ScriptHostBridge,
): ComponentHandlerRegistry {
  return new ComponentHandlerRegistry()
    .register(new RestComponent(httpRequest))
    .register(new ScriptComponent(new WorkerScriptEvaluator(), scriptBridge ?? unavailableScriptBridge()));
}

export type { ComponentHandler, ComponentExecuteParams, ComponentExecuteResult } from './base.js';
