import { describe, it, expect } from 'bun:test';
import { resolveTemplate } from '@/core/transform/resolve-template.js';

const scope = {
  context: {
    id: 12345, name: 'Alice', none: null, flag: false, items: [{ sku: 'A-1' }], obj: { a: 1 },
    output: { customerResponse: { id: 'C-1' } },
  },
  response: { status: 'active' },
};

describe('resolveTemplate', () => {
  it.each([
    ['$.context.id', 12345], ['$.context.flag', false], ['$.context.none', null],
    ['$.context.items[0].sku', 'A-1'], ['$.response.status', 'active'],
    ['$.context.output.customerResponse.id', 'C-1'], ['$.context.obj', { a: 1 }],
    ['$.context.items', [{ sku: 'A-1' }]],
  ])('resolves typed path %s', (source, expected) => {
    expect(resolveTemplate(source, scope)).toEqual(expected);
  });

  it('resolves whole roots', () => {
    expect(resolveTemplate('$.context', scope)).toEqual(scope.context);
    expect(resolveTemplate('$.response', scope)).toEqual(scope.response);
  });

  it.each([
    '$.context.missing', '$.response.missing', 'a-$.context.missing-b', '$env.NAME',
    '$..name', '$[*]', '$.context.items[*]', '$.context.items[1:3]',
    '$.context.items[?(@.sku)]', '$.context.items[0]sku', '$.context.', '$.context..id',
    '$.context.items[0', 'v=$.context.items[*]', 'v=$.context.items[0',
    'v=$.context.items["sku"]', 'v=$.context.items[0].',
    '$.context.id]', 'v=$.context.items[0]]',
  ])('preserves unresolved or malformed template %s', (source) => {
    expect(resolveTemplate(source, scope)).toBe(source);
  });

  it('substitutes multiple embedded paths and serializes objects and arrays', () => {
    expect(resolveTemplate('prefix-$.context.id-suffix', scope)).toBe('prefix-12345-suffix');
    expect(resolveTemplate('$.context.name/$.context.id', scope)).toBe('Alice/12345');
    expect(resolveTemplate('v=$.context.obj', scope)).toBe('v={"a":1}');
    expect(resolveTemplate('v=$.context.items', scope)).toBe('v=[{"sku":"A-1"}]');
    expect(resolveTemplate('v=$.context.none,$.context.flag', scope)).toBe('v=null,false');
    expect(resolveTemplate('$.context.id/$.context.missing', scope)).toBe('12345/$.context.missing');
  });

  it('recurses without mutating the template or scope', () => {
    const template = Object.freeze({ customer: Object.freeze({ id: '$.context.id' }), list: ['$.context.name'] });
    expect(resolveTemplate(template, scope)).toEqual({ customer: { id: 12345 }, list: ['Alice'] });
    expect(template.customer.id).toBe('$.context.id');
    expect(scope.context.id).toBe(12345);
  });

  it('constructs prototype-safe output with all own JSON keys preserved', () => {
    const template = JSON.parse('{"__proto__":{"value":"$.context.id"},"constructor":"$.context.name"}');
    const result = resolveTemplate(template, scope) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual({ value: 12345 });
    expect(Object.getOwnPropertyDescriptor(result, 'constructor')?.value).toBe('Alice');
    expect(Object.hasOwn(result, 'value')).toBe(false);
  });

  it.each([42, true, false, null, undefined])('passes primitives through: %s', (value) => {
    expect(resolveTemplate(value, scope)).toBe(value);
  });
});
