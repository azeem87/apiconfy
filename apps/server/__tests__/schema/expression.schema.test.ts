import { describe, it, expect } from 'bun:test';
import { pathExpression } from '@/core/schema/index.js';

describe('pathExpression', () => {
  it('accepts valid $context paths', () => {
    expect(pathExpression().safeParse('{$context.id}').success).toBe(true);
    expect(pathExpression().safeParse('{$context.name}').success).toBe(true);
    expect(pathExpression().safeParse('{$context.nested.deep.value}').success).toBe(true);
  });

  it('accepts valid $output paths', () => {
    expect(pathExpression().safeParse('{$output.status}').success).toBe(true);
    expect(pathExpression().safeParse('{$output.data.id}').success).toBe(true);
  });

  it('accepts valid $env paths', () => {
    expect(pathExpression().safeParse('{$env.NAME}').success).toBe(true);
    expect(pathExpression().safeParse('{$env.DB_PASSWORD}').success).toBe(true);
  });

  it('rejects empty and whitespace-only strings', () => {
    expect(pathExpression().safeParse('').success).toBe(false);
    expect(pathExpression().safeParse('  ').success).toBe(false);
  });

  it('rejects paths without the {$...} wrapper', () => {
    expect(pathExpression().safeParse('context.id').success).toBe(false);
    expect(pathExpression().safeParse('response.status').success).toBe(false);
  });

  it('rejects unknown namespaces', () => {
    expect(pathExpression().safeParse('{$foo.id}').success).toBe(false);
    expect(pathExpression().safeParse('{$bar.data}').success).toBe(false);
  });

  it('rejects incomplete paths', () => {
    expect(pathExpression().safeParse('{$context.}').success).toBe(false);
    expect(pathExpression().safeParse('{$output.}').success).toBe(false);
  });

  it('rejects paths with missing closing brace', () => {
    expect(pathExpression().safeParse('{$context.id').success).toBe(false);
    expect(pathExpression().safeParse('{$output.status').success).toBe(false);
  });
});
