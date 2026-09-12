import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import { SchemaRegistry, createCoreSchemaRegistry } from '@/core/schema/index.js';

describe('SchemaRegistry', () => {
  it('registers and retrieves a schema', () => {
    const schema = z.object({ a: z.string() });
    const registry = new SchemaRegistry().register('custom', schema);

    expect(registry.has('custom')).toBe(true);
    expect(registry.get('custom')).toBe(schema);
  });

  it('returns undefined for an unregistered type', () => {
    const registry = new SchemaRegistry();
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.has('nope')).toBe(false);
  });

  it('is chainable', () => {
    const registry = new SchemaRegistry()
      .register('a', z.string())
      .register('b', z.string());
    expect(registry.registeredTypes()).toEqual(['a', 'b']);
  });

  it('lists registered types in deterministic sorted order', () => {
    const registry = new SchemaRegistry()
      .register('zeta', z.string())
      .register('alpha', z.string());
    expect(registry.registeredTypes()).toEqual(['alpha', 'zeta']);
  });

  it('last registration wins for a duplicate key', () => {
    const second = z.number();
    const registry = new SchemaRegistry()
      .register('dup', z.string())
      .register('dup', second);
    expect(registry.get('dup')).toBe(second);
  });

  it('accepts a plugin type unknown to the core', () => {
    const registry = createCoreSchemaRegistry();
    expect(registry.has('acme-crm')).toBe(false);

    registry.register('acme-crm', z.object({ tenant: z.string() }).strict());

    expect(registry.has('acme-crm')).toBe(true);
    expect(registry.get('acme-crm')!.safeParse({ tenant: 't1' }).success).toBe(true);
  });

  it('createCoreSchemaRegistry ships rest and nothing else in Phase 1', () => {
    expect(createCoreSchemaRegistry().registeredTypes()).toEqual(['rest']);
  });

  it('returns an independent registry per call, so tests cannot leak into each other', () => {
    const a = createCoreSchemaRegistry();
    a.register('leaky', z.string());
    expect(createCoreSchemaRegistry().has('leaky')).toBe(false);
  });
});
