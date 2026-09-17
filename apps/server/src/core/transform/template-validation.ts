import { parsePath } from './path.js';

/** The namespaces the execution bag provides; a template using anything else can never resolve. */
export const TEMPLATE_ROOTS = new Set(['context', 'output', 'env']);

export interface TemplateIssue {
  path: string[];
  value: string;
  message: string;
}

const MALFORMED = 'Malformed template — expected {$context.path}, {$output.path} or {$env.NAME}';
const BAD_ROOT = 'Template must start with context, output or env — nothing else resolves';
const UNTERMINATED = 'Unterminated template — missing "}"';

/**
 * Registration-time validation for template fields.
 *
 * `resolveTemplate` resolves a `{$...}` candidate only when it parses *and* its root exists in the
 * bag; anything else is left literal on the wire. Silent literality is the failure mode this
 * guards against: a typo like `{$ context.id}` ships as text and the upstream rejects the request,
 * instead of the registry rejecting the config.
 *
 * Scans the same spans the runtime scans (`{$` to the first `}`) and reports every candidate that
 * cannot resolve. Values only — `resolveTemplate` never resolves object keys, so keys are skipped.
 */
export function collectTemplateIssues(value: unknown, path: string[] = []): TemplateIssue[] {
  if (typeof value === 'string') return candidateIssues(value, path);

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectTemplateIssues(item, [...path, String(index)]));
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => collectTemplateIssues(child, [...path, key]));
  }

  return [];
}

function candidateIssues(source: string, path: string[]): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf('{$', cursor);
    if (start === -1) break;

    const end = source.indexOf('}', start);
    if (end === -1) {
      issues.push({ path, value: source.slice(start), message: UNTERMINATED });
      break;
    }

    const candidate = source.slice(start, end + 1);
    const segments = parsePath(candidate);
    if (!segments) {
      issues.push({ path, value: candidate, message: MALFORMED });
    } else if (!TEMPLATE_ROOTS.has(String(segments[0].value))) {
      issues.push({ path, value: candidate, message: BAD_ROOT });
    }

    cursor = end + 1;
  }

  return issues;
}
