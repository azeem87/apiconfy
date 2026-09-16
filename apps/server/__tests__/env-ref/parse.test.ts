import { describe, it, expect } from 'bun:test';
import { isEnvRef, parseEnvRef, collectEnvRefIssues } from '@/core/env-ref/index.js';

describe('isEnvRef / parseEnvRef', () => {
  it('recognises a well-formed reference', () => {
    expect(isEnvRef('{$env.CRM_PASSWORD}')).toBe(true);
    expect(parseEnvRef('{$env.CRM_PASSWORD}')).toBe('CRM_PASSWORD');
  });

  it('allows a leading underscore', () => {
    expect(parseEnvRef('{$env._PRIVATE}')).toBe('_PRIVATE');
  });

  it('is anchored — an embedded reference is a literal', () => {
    expect(isEnvRef('prefix-{$env.NAME}')).toBe(false);
    expect(isEnvRef('{$env.NAME}-suffix')).toBe(false);
  });

  it('rejects a name starting with a digit', () => {
    expect(parseEnvRef('{$env.9LIVES}')).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(parseEnvRef('{$env.}')).toBeNull();
  });

  it('does not collide with expression-engine path syntax', () => {
    expect(isEnvRef('{$context.id}')).toBe(false);
    expect(isEnvRef('{$env')).toBe(false);
  });

  it('ignores non-strings', () => {
    expect(isEnvRef(42)).toBe(false);
    expect(parseEnvRef(null)).toBeNull();
    expect(parseEnvRef(undefined)).toBeNull();
  });
});

describe('collectEnvRefIssues', () => {
  it('reports nothing for a config with no references', () => {
    expect(collectEnvRefIssues({ uri: 'https://x.test', method: 'GET' })).toEqual([]);
  });

  it('leaves an embedded {$env.} alone — it is a literal, not a malformed reference', () => {
    expect(collectEnvRefIssues({ note: 'prefix-{$env.NAME}' })).toEqual([]);
    expect(collectEnvRefIssues({ note: 'read the docs at {$env.README}' })).toEqual([]);
  });

  it('flags a leading {$env.} with trailing content as malformed', () => {
    const issues = collectEnvRefIssues({ password: '{$env.NAME} trailing' }, ['config']);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['config', 'password']);
  });

  it('reports nothing for well-formed references', () => {
    const config = { auth: { basic: { username: 'u', password: '{$env.PW}' } } };
    expect(collectEnvRefIssues(config)).toEqual([]);
  });

  it('reports a malformed reference with its path', () => {
    const issues = collectEnvRefIssues({ auth: { basic: { password: '{$env.}' } } }, ['config']);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['config', 'auth', 'basic', 'password']);
    expect(issues[0].value).toBe('{$env.}');
  });

  it('reports malformed references inside arrays with an index path', () => {
    const issues = collectEnvRefIssues({ list: ['ok', '{$env.1BAD}'] });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['list', '1']);
  });

  it('reports every malformed reference, not just the first', () => {
    const issues = collectEnvRefIssues({ a: '{$env.}', b: '{$env.9x}' });
    expect(issues).toHaveLength(2);
  });

  it('treats a plain string that merely mentions env as a literal', () => {
    expect(collectEnvRefIssues({ note: 'set the env var first' })).toEqual([]);
  });
});
