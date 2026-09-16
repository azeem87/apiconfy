import { expect, it } from 'bun:test';
import { resolveTemplate } from '@/core/transform/index.js';

it('resolves $context paths from the scope', () => {
  const scope = { context: { id: 42, name: 'test' }, env: {}, output: null };
  expect(resolveTemplate('{$context.id}', scope)).toBe(42);
  expect(resolveTemplate('{$context.name}', scope)).toBe('test');
});

it('resolves $output paths from the scope', () => {
  const scope = { context: {}, env: {}, output: { status: 200, data: { id: 'x' } } };
  expect(resolveTemplate('{$output.status}', scope)).toBe(200);
  expect(resolveTemplate('{$output.data.id}', scope)).toBe('x');
});

it('returns literal for missing $context paths', () => {
  const scope = { context: { id: 1 }, env: {}, output: null };
  expect(resolveTemplate('{$context.missing}', scope)).toBe('{$context.missing}');
});

it('returns literal for missing $output paths', () => {
  const scope = { context: {}, env: {}, output: { id: 1 } };
  expect(resolveTemplate('{$output.missing}', scope)).toBe('{$output.missing}');
});

it('resolves $env references from the scope', () => {
  const scope = { context: {}, env: { API_KEY: 'secret' }, output: null };
  expect(resolveTemplate('{$env.API_KEY}', scope)).toBe('secret');
});

it('handles null $output gracefully', () => {
  const scope = { context: { id: 1 }, env: {}, output: null };
  expect(resolveTemplate('{$output.id}', scope)).toBe('{$output.id}');
});
