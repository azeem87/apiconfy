import { SchemaRegistry } from './schema-registry.js';
import { RestConfigSchema } from './rest.schema.js';
import { ScriptConfigSchema } from './script.schema.js';

export * from './common.schema.js';
export * from './rest.schema.js';
export * from './script.schema.js';
export * from './register-service.schema.js';
export * from './schema-registry.js';

/**
 * The registry the server starts with. Phase 1 ships `rest`; Phase 3.5 adds the local `script`
 * component (plans/script-component.md D2 — registered by default, so the boundary is API access).
 */
export function createCoreSchemaRegistry(): SchemaRegistry {
  return new SchemaRegistry()
    .register('rest', RestConfigSchema)
    .register('script', ScriptConfigSchema);
}
