import { describe, it, expect } from 'bun:test';
import { generateId } from '@/lib/id.js';

describe('generateId', () => {
  it('returns a UUID string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateId()));
    expect(ids.size).toBe(10);
  });
});
