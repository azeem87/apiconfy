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

it('retains a private secret collection when a later reference is missing', () => {
  const secrets: string[] = [];
  expect(() => resolveEnvRefsDetailed(
    { first: '$env.PRESENT', second: '$env.MISSING' }, { PRESENT: 'private' },
    secret => { secrets.push(secret); }
  )).toThrow('MISSING');
  expect(secrets).toEqual(['private']);
});
