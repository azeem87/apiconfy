import { lookupPath, parsePath } from './path.js';
import type { ExpressionScope } from './scope.js';

const EMBEDDED_PATH = /\{\$[A-Za-z_$][A-Za-z0-9_.$\[\]]*(?:\[[^\]]*(?:\]|$)[A-Za-z0-9_.$\]]*)*\}/g;

function resolveString(source: string, scope: ExpressionScope): unknown {
  const segments = parsePath(source);
  if (segments) {
    const lookup = lookupPath(scope, segments);
    return lookup.found ? lookup.value : source;
  }

  return source.replace(EMBEDDED_PATH, (match) => {
    const embedded = parsePath(match);
    if (!embedded) return match;
    const lookup = lookupPath(scope, embedded);
    if (!lookup.found || lookup.value === undefined) return match;
    return typeof lookup.value === 'object' ? JSON.stringify(lookup.value) : String(lookup.value);
  });
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
