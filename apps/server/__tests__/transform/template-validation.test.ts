import { describe, it, expect } from 'bun:test';
import { collectTemplateIssues } from '@/core/transform/template-validation.js';

describe('collectTemplateIssues', () => {
  it('accepts resolvable templates, including nesting, arrays and every root', () => {
    const uri = 'https://api.test/{$context.id}/{$output.status}?key={$env.NAME}';
    expect(collectTemplateIssues(uri)).toEqual([]);
    expect(collectTemplateIssues({
      headers: { 'X-Tenant': '{$context.tenant}', 'X-Key': '{$env.API_KEY}' },
      body: { items: ['{$context.items[0].sku}'], nested: { deep: '{$output.id}' } },
    })).toEqual([]);
    expect(collectTemplateIssues('no templates here')).toEqual([]);
    expect(collectTemplateIssues(42)).toEqual([]);
  });

  it('reports a malformed candidate with its path', () => {
    const issues = collectTemplateIssues({ headers: { 'X-Tenant': '{$ context.id}' } });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(['headers', 'X-Tenant']);
    expect(issues[0].value).toBe('{$ context.id}');
    expect(issues[0].message).toContain('Malformed template');
  });

  it.each(['{$context.id }', '{$context["id"]}', '{$context.items[*]}', '{$context..id}'])(
    'rejects the grammar-invalid candidate %s', (candidate) => {
      expect(collectTemplateIssues(candidate)).toHaveLength(1);
    }
  );

  it('reports an unterminated template', () => {
    const issues = collectTemplateIssues('https://api.test/{$context.id');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('Unterminated');
  });

  it('rejects a root the bag does not provide — that template can never resolve', () => {
    for (const candidate of ['{$contex.id}', '{$foo.id}', '{$response.id}', '{$body.id}']) {
      const issues = collectTemplateIssues(candidate);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('must start with context, output or env');
    }
  });

  it('reports every candidate in one string, including one swallowed by a malformed span', () => {
    // Same scan as the runtime: the first candidate runs to the first `}`, so the malformed one
    // swallows the valid path that follows it. Both are reported, so nothing hides.
    const issues = collectTemplateIssues('{$a.b {$context.id}');
    expect(issues).toHaveLength(1);
    expect(issues[0].value).toBe('{$a.b {$context.id}');
  });

  it('validates values, not keys — resolveTemplate never resolves a key', () => {
    expect(collectTemplateIssues({ '{$context.keyName}': 'plain' })).toEqual([]);
  });
});
