import { describe, expect, it } from 'bun:test';
import type { ValidationField } from '@/core/types.js';
import { collectFieldFailures, parseFieldPath } from '@/core/runtime/request-validation.js';
import { TransformationError } from '@/lib/errors.js';

describe('parseFieldPath', () => {
  it('parses dotted keys, indices, wildcards and quoted keys', () => {
    expect(parseFieldPath('userId')).toEqual([{ kind: 'key', value: 'userId' }]);
    expect(parseFieldPath('customer.email')).toEqual([
      { kind: 'key', value: 'customer' }, { kind: 'key', value: 'email' },
    ]);
    expect(parseFieldPath('items[0].sku')).toEqual([
      { kind: 'key', value: 'items' }, { kind: 'index', value: 0 }, { kind: 'key', value: 'sku' },
    ]);
    expect(parseFieldPath('items[*].sku')).toEqual([
      { kind: 'key', value: 'items' }, { kind: 'wildcard' }, { kind: 'key', value: 'sku' },
    ]);
    expect(parseFieldPath('customer["user-id"].email')).toEqual([
      { kind: 'key', value: 'customer' }, { kind: 'quoted', value: 'user-id' }, { kind: 'key', value: 'email' },
    ]);
    expect(parseFieldPath('["first name"]')).toEqual([{ kind: 'quoted', value: 'first name' }]);
    expect(parseFieldPath('items[0]["a.b"]')).toEqual([
      { kind: 'key', value: 'items' }, { kind: 'index', value: 0 }, { kind: 'quoted', value: 'a.b' },
    ]);
  });

  it.each([
    '', ' ', '.a', 'a.', 'a..b', 'a[*', 'a[-1]', 'a[1:2]', 'a[""]', 'a.*', '9abc', 'a b',
    '{$context.id}', 'a.{$context.id}', 'a[0',
  ])('rejects unsupported path %s', (source) => {
    expect(parseFieldPath(source)).toBeNull();
  });
});

describe('collectFieldFailures', () => {
  const collect = (fields: ValidationField[], payload: Record<string, unknown>) =>
    collectFieldFailures(fields, payload);

  it('reports missing and null required fields with generated messages', () => {
    expect(collect([{ path: 'userId', required: true }], {})).toEqual([
      { path: ['userId'], message: 'userId is required' },
    ]);
    expect(collect([{ path: 'customer.email', required: true }], { customer: { email: null } })).toEqual([
      { path: ['customer', 'email'], message: 'customer.email is required' },
    ]);
    expect(collect([{ path: 'customer.email', required: true }], { customer: null })).toEqual([
      { path: ['customer', 'email'], message: 'customer.email is required' },
    ]);
  });

  it('treats falsy values as present', () => {
    const fields: ValidationField[] = [
      { path: 'zero', required: true }, { path: 'flag', required: true }, { path: 'text', required: true },
      { path: 'list', required: true }, { path: 'map', required: true },
    ];
    expect(collect(fields, { zero: 0, flag: false, text: '', list: [], map: {} })).toEqual([]);
  });

  it('checks each type strictly', () => {
    expect(collect([{ path: 'value', type: 'string' }], { value: 7 })).toEqual([
      { path: ['value'], message: 'value must be a string' },
    ]);
    expect(collect([{ path: 'value', type: 'number' }], { value: '7' })).toEqual([
      { path: ['value'], message: 'value must be a number' },
    ]);
    expect(collect([{ path: 'value', type: 'integer' }], { value: 2.5 })).toEqual([
      { path: ['value'], message: 'value must be an integer' },
    ]);
    expect(collect([{ path: 'value', type: 'boolean' }], { value: 'true' })).toEqual([
      { path: ['value'], message: 'value must be a boolean' },
    ]);
    expect(collect([{ path: 'value', type: 'array' }], { value: {} })).toEqual([
      { path: ['value'], message: 'value must be an array' },
    ]);
    expect(collect([{ path: 'value', type: 'object' }], { value: [] })).toEqual([
      { path: ['value'], message: 'value must be an object' },
    ]);
    expect(collect([{ path: 'value', type: 'string' }], { value: null })).toHaveLength(1);
    expect(collect([{ path: 'value', type: 'number' }], { value: 2.0 })).toEqual([]);
    expect(collect([{ path: 'value', type: 'integer' }], { value: 2 })).toEqual([]);
  });

  it('checks minItems and minLength', () => {
    expect(collect([{ path: 'items', type: 'array', minItems: 1 }], { items: [] })).toEqual([
      { path: ['items'], message: 'items must contain at least 1 entry' },
    ]);
    expect(collect([{ path: 'items', type: 'array', minItems: 2 }], { items: [1] })).toEqual([
      { path: ['items'], message: 'items must contain at least 2 entries' },
    ]);
    expect(collect([{ path: 'items', type: 'array', minItems: 1 }], { items: [1] })).toEqual([]);
    expect(collect([{ path: 'text', type: 'string', minLength: 1 }], { text: '' })).toEqual([
      { path: ['text'], message: 'text must have at least 1 character' },
    ]);
    expect(collect([{ path: 'text', type: 'string', minLength: 2 }], { text: 'a' })).toEqual([
      { path: ['text'], message: 'text must have at least 2 characters' },
    ]);
    expect(collect([{ path: 'text', type: 'string', minLength: 1 }], { text: 'a' })).toEqual([]);
  });

  it('lets a custom message override the generated one, aborting each field at its first failure', () => {
    expect(collect([{ path: 'userId', required: true, type: 'string', message: 'userId is mandatory' }], {})).toEqual([
      { path: ['userId'], message: 'userId is mandatory' },
    ]);
    expect(collect([{ path: 'userId', required: true, type: 'string' }], { userId: 7 })).toEqual([
      { path: ['userId'], message: 'userId must be a string' },
    ]);
  });

  it('handles wildcards with concrete indices, empty arrays and broken collections', () => {
    expect(collect([{ path: 'items[*].sku', required: true }], { items: [{ sku: 'A' }, { qty: 1 }] })).toEqual([
      { path: ['items', 1, 'sku'], message: 'items[1].sku is required' },
    ]);
    expect(collect([{ path: 'items[*].sku', required: true }], { items: [] })).toEqual([]);
    expect(collect([{ path: 'items[*].sku', required: true }], {})).toEqual([
      { path: ['items', '*'], message: 'items must be an array' },
    ]);
    expect(collect([{ path: 'items[*].sku', required: true }], { items: {} })).toEqual([
      { path: ['items', '*'], message: 'items must be an array' },
    ]);
    expect(collect(
      [{ path: 'orders[*].items[*].sku', required: true }],
      { orders: [{ items: [{ sku: 'a' }, { qty: 1 }] }] },
    )).toEqual([{ path: ['orders', 0, 'items', 1, 'sku'], message: 'orders[0].items[1].sku is required' }]);
  });

  it('supports quoted keys with readable messages', () => {
    expect(collect([{ path: 'meta["external-id"]', required: true }], { meta: {} })).toEqual([
      { path: ['meta', 'external-id'], message: 'meta["external-id"] is required' },
    ]);
  });

  it('does not resolve through nulls, prototypes or missing indices', () => {
    expect(collect([{ path: 'items[5].sku', required: true }], { items: [{ sku: 'A' }] })).toEqual([
      { path: ['items', 5, 'sku'], message: 'items[5].sku is required' },
    ]);
    expect(collect([{ path: 'value.toString', required: true }], { value: {} })).toEqual([
      { path: ['value', 'toString'], message: 'value.toString is required' },
    ]);
  });

  it('reports multiple fields in configuration order', () => {
    expect(collect(
      [{ path: 'userId', required: true }, { path: 'items', type: 'array', minItems: 1 }],
      { items: [] },
    )).toEqual([
      { path: ['userId'], message: 'userId is required' },
      { path: ['items'], message: 'items must contain at least 1 entry' },
    ]);
  });

  it('fails loudly on a malformed stored path', () => {
    expect(() => collect([{ path: 'a..b', required: true }], {})).toThrow(TransformationError);
  });
});
