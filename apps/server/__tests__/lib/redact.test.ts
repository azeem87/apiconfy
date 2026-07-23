import { describe, it, expect } from 'bun:test';
import { redactSensitiveFields } from '@/lib/redact.js';

describe('redactSensitiveFields', () => {
  it('masks password fields', () => {
    const result = redactSensitiveFields({ password: 'secret123', name: 'test' });
    expect(result).toEqual({ password: '***', name: 'test' });
  });

  it('masks nested secrets', () => {
    const result = redactSensitiveFields({
      config: { clientSecret: 'abc', url: 'https://example.com' },
    });
    expect(result).toEqual({ config: { clientSecret: '***', url: 'https://example.com' } });
  });

  it('handles arrays', () => {
    const result = redactSensitiveFields([{ token: 'x' }, { name: 'y' }]);
    expect(result).toEqual([{ token: '***' }, { name: 'y' }]);
  });

  it('returns non-objects as-is', () => {
    expect(redactSensitiveFields(null)).toBeNull();
    expect(redactSensitiveFields(42)).toBe(42);
    expect(redactSensitiveFields('hello')).toBe('hello');
  });
});
