import { SchemaRegistry } from './schema-registry.js';
import { RestConfigSchema } from './rest.schema.js';

export * from './common.schema.js';
export * from './rest.schema.js';
export * from './register-service.schema.js';
export * from './schema-registry.js';

/**
 * The registry the server starts with. Phase 1 ships `rest` only.
 */
export function createCoreSchemaRegistry(): SchemaRegistry {
  return new SchemaRegistry().register('rest', RestConfigSchema);
}
