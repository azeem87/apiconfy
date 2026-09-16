import { describe, it, expect } from 'bun:test';
import { resolveEnvRefs, EnvRefResolutionError } from '@/core/env-ref/index.js';

const env = { CRM_PASSWORD: 'hunter2', EMPTY: '' };

describe('resolveEnvRefs', () => {
  it('resolves a reference from the injected env', () => {
    expect(resolveEnvRefs({ password: '{$env.CRM_PASSWORD}' }, env))
      .toEqual({ password: 'hunter2' });
  });

  it('leaves literals untouched', () => {
    expect(resolveEnvRefs({ password: 'hunter2' }, env)).toEqual({ password: 'hunter2' });
  });

  it('resolves at any depth and inside arrays', () => {
    const resolved = resolveEnvRefs({
      auth: { basic: { password: '{$env.CRM_PASSWORD}' } },
      list: ['{$env.CRM_PASSWORD}'],
    }, env);
    expect(resolved.auth.basic.password).toBe('hunter2');
    expect(resolved.list[0]).toBe('hunter2');
  });

  it('throws when the variable is unset', () => {
    expect(() => resolveEnvRefs({ password: '{$env.MISSING}' }, env))
      .toThrow(EnvRefResolutionError);
  });

  it('names the variable and its path in the error, but never a value', () => {
    try {
      resolveEnvRefs({ auth: { basic: { password: '{$env.MISSING}' } } }, env);
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as EnvRefResolutionError;
      expect(e.code).toBe('ENV_REF_UNRESOLVED');
      expect(e.message).toContain('MISSING');
      expect(e.message).toContain('auth.basic.password');
      expect(e.message).not.toContain('hunter2');
    }
  });

  it('resolves an explicitly empty variable to an empty string, not an error', () => {
    expect(resolveEnvRefs({ v: '{$env.EMPTY}' }, env)).toEqual({ v: '' });
  });

  it('does not mutate the input', () => {
    const original = { password: '{$env.CRM_PASSWORD}' };
    resolveEnvRefs(original, env);
    expect(original.password).toBe('{$env.CRM_PASSWORD}');
  });

  it('preserves non-string values', () => {
    expect(resolveEnvRefs({ timeout: 5000, enabled: false }, env))
      .toEqual({ timeout: 5000, enabled: false });
  });
});
