import { describe, it, expect } from 'bun:test';
import { maskEnvRefs } from '@/core/env-ref/index.js';

describe('maskEnvRefs', () => {
  it('masks a reference', () => {
    expect(maskEnvRefs({ password: '$env.PW' })).toEqual({ password: '****' });
  });

  it('leaves a literal secret untouched — that is the policy, not an oversight', () => {
    expect(maskEnvRefs({ password: 'hunter2' })).toEqual({ password: 'hunter2' });
  });

  it('masks by value, not by field name', () => {
    const masked = maskEnvRefs({
      harmlessField: '$env.SOME_VAR',
      password: 'literal-value',
    });
    expect(masked).toEqual({ harmlessField: '****', password: 'literal-value' });
  });

  it('masks at any depth', () => {
    const masked = maskEnvRefs({
      auth: { oauth2: { clientId: 'public', clientSecret: '$env.SECRET' } },
    });
    expect(masked.auth.oauth2).toEqual({ clientId: 'public', clientSecret: '****' });
  });

  it('masks inside arrays', () => {
    expect(maskEnvRefs({ items: ['plain', '$env.X'] })).toEqual({ items: ['plain', '****'] });
  });

  it('does not mutate the input', () => {
    const original = { auth: { basic: { password: '$env.PW' } } };
    maskEnvRefs(original);
    expect(original.auth.basic.password).toBe('$env.PW');
  });

  it('preserves non-string values', () => {
    const masked = maskEnvRefs({ timeout: 5000, enabled: true, missing: null });
    expect(masked).toEqual({ timeout: 5000, enabled: true, missing: null });
  });

  it('leaves a malformed reference alone (registration rejects it instead)', () => {
    expect(maskEnvRefs({ password: '$env.' })).toEqual({ password: '$env.' });
  });

  it('does not touch user data in payloadTemplate that merely has a secret-ish key', () => {
    const config = { payloadTemplate: { apiKey: '$.context.apiKey', password: '$.context.pw' } };
    expect(maskEnvRefs(config)).toEqual(config);
  });
});
