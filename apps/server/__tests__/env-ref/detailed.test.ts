import { expect, it } from 'bun:test';
import { resolveEnvRefsDetailed } from '@/core/env-ref/index.js';
import { scrubSecretValues } from '@/lib/redact.js';

it('captures short and repeated resolved secrets without mutating config', () => {
  const config = { uri: '$env.URL', nested: ['$env.KEY', '$env.KEY'], empty: '$env.EMPTY' };
  const resolved = resolveEnvRefsDetailed(config, { URL: 'https://host.test', KEY: 'xy', EMPTY: '' });
  expect(resolved.secrets).toEqual(['https://host.test', 'xy']);
  expect(config.nested).toEqual(['$env.KEY', '$env.KEY']);
  expect(scrubSecretValues({ echo: 'xy', uri: resolved.config.uri }, resolved.secrets))
    .toEqual({ echo: '***', uri: '***' });
});

it('retains a private secret collection when a later reference is missing', () => {
  const secrets: string[] = [];
  expect(() => resolveEnvRefsDetailed(
    { first: '$env.PRESENT', second: '$env.MISSING' }, { PRESENT: 'private' },
    secret => { secrets.push(secret); }
  )).toThrow('MISSING');
  expect(secrets).toEqual(['private']);
});
