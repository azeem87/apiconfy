import type { z } from 'zod';

/**
 * Runtime, keyed dispatch from `componentType` to its config schema.
 * Deliberately a mutable Map rather than a z.discriminatedUnion.
 */
export class SchemaRegistry {
  private readonly schemas = new Map<string, z.ZodTypeAny>();

  register(componentType: string, schema: z.ZodTypeAny): this {
    this.schemas.set(componentType, schema);
    return this;
  }

  get(componentType: string): z.ZodTypeAny | undefined {
    return this.schemas.get(componentType);
  }

  has(componentType: string): boolean {
    return this.schemas.has(componentType);
  }

  /** Sorted so error messages and OpenAPI output are deterministic. */
  registeredTypes(): string[] {
    return [...this.schemas.keys()].sort();
  }
}
