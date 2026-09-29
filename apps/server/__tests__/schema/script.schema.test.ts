import { describe, it, expect } from 'bun:test';
import { ScriptConfigSchema } from '@/core/schema/index.js';

const minimal = { expression: 'function ($context) { $context.sum = $context.a + $context.b; }' };

describe('ScriptConfigSchema', () => {
  it('accepts the minimal config — expression only', () => {
    expect(ScriptConfigSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts async expressions and timeout.response up to 120 000', () => {
    expect(ScriptConfigSchema.safeParse({
      expression: 'async function ($context) { await apiconfy.invoke("svc", "act"); }',
      timeout: { response: 120_000 },
    }).success).toBe(true);
  });

  it('accepts optional chaining and template literals (modern JS)', () => {
    expect(ScriptConfigSchema.safeParse({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the expression source intentionally contains JS template interpolation
      expression: 'function ($context) { $context.label = `Hi ${$context?.user?.name ?? "anon"}`; }',
    }).success).toBe(true);
  });

  it('rejects a missing, empty, or non-string expression', () => {
    expect(ScriptConfigSchema.safeParse({}).success).toBe(false);
    expect(ScriptConfigSchema.safeParse({ expression: '' }).success).toBe(false);
    expect(ScriptConfigSchema.safeParse({ expression: 42 }).success).toBe(false);
  });

  it('rejects syntax-invalid source at registration (compile-only check)', () => {
    const result = ScriptConfigSchema.safeParse({ expression: 'function ($context) { return ;;' });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].path).toEqual(['expression']);
  });

  it('rejects $env. references in the expression', () => {
    const result = ScriptConfigSchema.safeParse({
      expression: 'function ($context) { return "{$env.SECRET}"; }',
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message).toContain('$env.');
  });

  it('rejects every REST-only key (strict) — including the whole output block', () => {
    for (const extra of [
      { output: { transformation: { x: '{$output}' } } },
      { output: { key: 'x' } },
      { output: { validation: { rules: [{ expression: '{$output} != null' }] } } },
      { output: { default: {} } },
      { uri: 'https://x.test' },
      { method: 'GET' },
      { headers: {} },
      { auth: {} },
      { ssl: {} },
      { payloadTemplate: {} },
      { resilience: { retryCount: 1 } },
      { timeout: { connect: 1000 } },
      { timeout: { socket: 1000 } },
      { timeout: { idle: 1000 } },
    ]) {
      expect(
        ScriptConfigSchema.safeParse({ ...minimal, ...extra }).success,
        JSON.stringify(extra)
      ).toBe(false);
    }
  });

  it('rejects timeout.response out of bounds and non-integers', () => {
    expect(ScriptConfigSchema.safeParse({ ...minimal, timeout: { response: 120_001 } }).success).toBe(false);
    expect(ScriptConfigSchema.safeParse({ ...minimal, timeout: { response: 0 } }).success).toBe(false);
    expect(ScriptConfigSchema.safeParse({ ...minimal, timeout: { response: -1 } }).success).toBe(false);
    expect(ScriptConfigSchema.safeParse({ ...minimal, timeout: { response: 12.5 } }).success).toBe(false);
  });
});
