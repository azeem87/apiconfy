import { describe, it, expect } from 'bun:test';
import { parsePath, lookupPath } from '@/core/transform/path.js';

describe('parsePath', () => {
  it('parses keys and consecutive array indices', () => {
    expect(parsePath('{$context.items[0].sku}')).toEqual([
      { kind: 'key', value: 'context' }, { kind: 'key', value: 'items' },
      { kind: 'index', value: 0 }, { kind: 'key', value: 'sku' },
    ]);
    expect(parsePath('{$a[0][1]}')).toEqual([
      { kind: 'key', value: 'a' }, { kind: 'index', value: 0 }, { kind: 'index', value: 1 },
    ]);
    expect(parsePath('{$_key1}')).toEqual([{ kind: 'key', value: '_key1' }]);
  });

  it('parses $env paths (root validation is at expression/assertion level, not parsePath)', () => {
    expect(parsePath('{$env.NAME}')).toEqual([
      { kind: 'key', value: 'env' }, { kind: 'key', value: 'NAME' },
    ]);
  });

  it.each([
    'prefix-{$context.id}', '{$context.', '{$context..id}', '$context.id', '$', '', '{$',
    '{$a[0]b}', '{$a b}', '{$..name}', '{$[*]}', '{$a[*]}', '{$a[?(@.b)]}', '{$a[1:3]}',
    '{$a[-1]}', '{$a["key"]}', '{$a[0', '{$1key}', '{$a.[0]}',
  ])('rejects unsupported whole-string path %s', (source) => {
    expect(parsePath(source)).toBeNull();
  });
});

describe('lookupPath', () => {
  const root = { context: { items: [{ sku: 'A-1' }], none: null, undef: undefined, number: 3 } };
  const lookup = (path: string) => lookupPath(root, parsePath(path)!);

  it('returns typed values and distinguishes null/undefined from missing', () => {
    expect(lookup('{$context.items[0].sku}')).toEqual({ found: true, value: 'A-1' });
    expect(lookup('{$context.none}')).toEqual({ found: true, value: null });
    expect(lookup('{$context.undef}')).toEqual({ found: true, value: undefined });
    expect(lookup('{$context}')).toEqual({ found: true, value: root.context });
  });

  it.each([
    '{$context.missing}', '{$context.items[5]}', '{$context.items[0].sku.length}',
    '{$context.number.x}', '{$context.none.x}', '{$context.toString}',
    '{$context.items[0][0]}', '{$context.items[999999999999999999999999]}',
  ])('does not resolve %s', (path) => {
    expect(lookup(path)).toEqual({ found: false, value: undefined });
  });

  it('does not walk object or array prototypes, including sparse array indices', () => {
    const items = new Array(1);
    const prototype = Object.create(Array.prototype);
    prototype[0] = 'inherited';
    Object.setPrototypeOf(items, prototype);
    expect(lookupPath({ items }, parsePath('{$items[0]}')!).found).toBe(false);
    expect(lookupPath(Object.create({ inherited: 1 }), parsePath('{$inherited}')!).found).toBe(false);
    expect(lookupPath({ items: new Array(1) }, parsePath('{$items[0]}')!).found).toBe(false);
  });

  it('reads own prototype-shaped keys without traversing inherited ones', () => {
    const data = JSON.parse('{"__proto__":{"safe":true}}');
    expect(lookupPath(data, parsePath('{$__proto__.safe}')!)).toEqual({ found: true, value: true });
    expect(lookupPath({}, parsePath('{$__proto__}')!).found).toBe(false);
  });
});
