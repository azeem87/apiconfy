import { lookupPath, parsePath } from './path.js';
import type { ExpressionScope } from './scope.js';

/**
 * Scans left to right for `{$...}` candidates and validates each with `parsePath`, rather than
 * matching them with a single regex: a regex able to validate the whole `{$root.key[0].key}`
 * grammar inline needs nested quantifiers, which are quadratic on crafted input such as a long
 * run of unmatched `[` (measured: 16 KB → 821 ms). This scan is linear (1 MB → 0.4 ms).
 *
 * A candidate runs to the first `}` after `{$`. When it does not parse, it is left literal and
 * the scan resumes after that `}` — so a malformed candidate also suppresses a valid path nested
 * inside it (`{$a.b {$context.id}` stays fully literal). That is deliberate: registration-time
 * validation (`core/transform/template-validation.ts`) rejects malformed templates before they
 * can be stored, so neither behaviour is reachable for a config that was accepted. Note this
 * differs from `expression.ts`'s tokenizer, which throws on an invalid path — templates are data,
 * predicates are control flow.
 *
 * A candidate that parses but whose path is missing resolves to `null` — identical to a present
 * `null` value — so no `{$...}` text can leak into a payload, header or transformed output.
 * Missing-field protection is explicit elsewhere: `request.validation.fields` rejects the invoke
 * before dispatch, the uri guard rejects a non-string target, and predicates already read
 * missing as null-like.
 */
function resolveString(source: string, scope: ExpressionScope): unknown {
  const segments = parsePath(source);
  if (segments) {
    const lookup = lookupPath(scope, segments);
    return lookup.found && lookup.value !== undefined ? lookup.value : null;
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
      // A malformed candidate stays literal; a missing path becomes null, like a present null.
      result += embedded ? 'null' : candidate;
    } else {
      result += typeof lookup.value === 'object' ? JSON.stringify(lookup.value) : String(lookup.value);
    }
    cursor = end + 1;
  }
  return result;
}

/** Resolves templates without mutating them; missing paths resolve to null. */
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
