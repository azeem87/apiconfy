import { RestComponent } from './rest/rest.component.js';
import { ComponentHandlerRegistry } from '@/core/runtime/component-handler-registry.js';

export function createCoreHandlerRegistry(httpRequest: typeof fetch = globalThis.fetch): ComponentHandlerRegistry {
  return new ComponentHandlerRegistry().register(new RestComponent(httpRequest));
}

export type { ComponentHandler, ComponentExecuteParams, ComponentExecuteResult } from './base.js';
