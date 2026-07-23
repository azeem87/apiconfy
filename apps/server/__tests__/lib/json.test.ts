import { describe, it, expect } from 'bun:test';
import { deepMerge, safeJsonParse, safeJsonStringify } from '@/lib/json.js';

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('returns fallback on invalid JSON', () => {
    expect(safeJsonParse('bad', { default: true })).toEqual({ default: true });
  });
});

describe('deepMerge', () => {
  it('merges nested objects', () => {
    const result = deepMerge(
      { a: 1, b: { c: 2 } },
      { b: { d: 3 }, e: 4 },
    );
    expect(result).toEqual({ a: 1, b: { c: 2, d: 3 }, e: 4 });
  });

  it('source overwrites primitive values', () => {
    const result = deepMerge({ a: 1 }, { a: 2 });
    expect(result).toEqual({ a: 2 });
  });
});

describe('safeJsonStringify', () => {
  it('stringifies JSON', () => {
    expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  it('returns empty string on circular ref', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(safeJsonStringify(obj)).toBe('');
  });
});
