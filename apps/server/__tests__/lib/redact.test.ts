import { describe, it, expect } from 'bun:test';
import { redactSensitiveFields, scrubSecretValues } from '@/lib/redact.js';

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

describe('scrubSecretValues', () => {
  it('scrubs encoded/escaped secrets and property names without mutating input', () => {
    const secret = 'a "private"&+';
    const input = {
      [secret]: [secret, encodeURIComponent(secret), JSON.stringify({ value: secret })],
      form: new URLSearchParams({ value: secret }).toString(),
    };
    const output = JSON.stringify(scrubSecretValues(input, [secret, 'a "private"']));
    expect(output).not.toContain('private');
    expect(output).not.toContain('%22');
    expect(input[secret][0]).toBe(secret);
  });

  it('scrubs secrets echoed as non-string JSON scalars', () => {
    const result: unknown = scrubSecretValues({ code: 123456, flag: true, other: 7 }, ['123456', 'true']);
    expect(result).toEqual({ code: '***', flag: '***', other: 7 });
  });

  it('scrubs a short secret embedded in a larger message, but never a word that merely contains it', () => {
    const embedded = scrubSecretValues(
      { message: 'Invalid credential: abc12 rejected' }, ['abc12']
    ) as { message: string };
    expect(embedded.message).toBe('Invalid credential: *** rejected');

    const unrelated = scrubSecretValues({ note: 'the response was empty' }, ['e']) as { note: string };
    expect(unrelated.note).toBe('the response was empty');
  });

  it('scrubs a 6+ char secret even when glued to other alphanumerics, but keeps <6 char secrets boundary-guarded', () => {
    const long = scrubSecretValues(
      { a: 'abcdef123', b: '123abcdef', c: 'key_abcdef_prod' }, ['abcdef']
    ) as { a: string; b: string; c: string };
    expect(long).toEqual({ a: '***123', b: '123***', c: 'key_***_prod' });

    // Documented residual gap: a <6-char secret glued to other alphanumerics (no delimiter)
    // is not caught, to avoid corrupting unrelated words that merely contain it (see above).
    const short = scrubSecretValues({ c: 'key_abc12_prod' }, ['abc12']) as { c: string };
    expect(short.c).toBe('key_abc12_prod');
  });
});
