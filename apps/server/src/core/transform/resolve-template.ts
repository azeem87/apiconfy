import { lookupPath, parsePath } from './path.js';
import type { ExpressionScope } from './scope.js';

/**
 * Scans left to right for `{$...}` candidates and validates each with `parsePath`,
 * rather than matching them with a single regex. A regex expressive enough to validate
 * the whole `{$root.key[0].key}` grammar inline requires nested quantifiers that are
 * quadratic (or worse) on crafted input such as a long run of unmatched `[` characters —
 * this linear scan has no such blowup. Mirrors the equivalent scan in expression.ts's tokenizer.
 */
function resolveString(source: string, scope: ExpressionScope): unknown {
  const segments = parsePath(source);
  if (segments) {
    const lookup = lookupPath(scope, segments);
    return lookup.found ? lookup.value : source;
  }

  let result = '';
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('{$', cursor);
    if (start === -1) {
      result += source.slice(cursor);
      break;
    }
    const end = source.indexOf('}', start);
    if (end === -1) {
      result += source.slice(cursor);
      break;
    }
    result += source.slice(cursor, start);
    const candidate = source.slice(start, end + 1);
    const embedded = parsePath(candidate);
    const lookup = embedded ? lookupPath(scope, embedded) : undefined;
    if (!lookup?.found || lookup.value === undefined) {
      result += candidate;
    } else {
      result += typeof lookup.value === 'object' ? JSON.stringify(lookup.value) : String(lookup.value);
    }
    cursor = end + 1;
  }
  return result;
}

/** Resolves templates without mutating them; unresolved paths remain literal. */
export function resolveTemplate(template: unknown, scope: ExpressionScope): unknown {
  if (typeof template === 'string') return resolveString(template, scope);
  if (Array.isArray(template)) return template.map((item) => resolveTemplate(item, scope));
  if (template !== null && typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, resolveTemplate(value, scope)])
    );
  }
  return template;
}
