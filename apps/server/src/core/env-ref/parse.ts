/**
 * `{$env.<NAME>}` reference support.
 *
 * Uses the same `{$...}` expression syntax as the template engine, with the `$env`
 * namespace distinguishing environment references from context/output paths.
 */

/** Anchored: the whole string must be the reference. "prefix-{$env.X}" is a literal. */
const ENV_REF_PATTERN = /^\{\$env\.([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Detects a string that *starts with* `{$env.` even when the name is invalid, so we can
 * report it rather than store it. Embedded `{$env.` (e.g. `prefix-{$env.NAME}`) is a literal.
 */
const ENV_REF_PREFIX = /^\{\$env\./;

export const MASK = '****';

export function isEnvRef(value: unknown): value is string {
  return typeof value === 'string' && ENV_REF_PATTERN.test(value);
}

/** Returns the variable NAME, or null when `value` is not a well-formed reference. */
export function parseEnvRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ENV_REF_PATTERN.exec(value);
  return match?.[1] ?? null;
}

export interface EnvRefIssue {
  path: string[];
  value: string;
  message: string;
}

/**
 * Walks any value and reports strings that *look* like `{$env.` references but are
 * malformed. Rejecting these at registration is the point: storing "{$env." as a literal
 * would later ship that exact string upstream as a password.
 */
export function collectEnvRefIssues(value: unknown, path: string[] = []): EnvRefIssue[] {
  if (typeof value === 'string') {
    if (value === MASK || value === '***') {
      return [{
        path,
        value,
        message: 'Masked values ("****" or "***") are placeholders returned by read APIs and cannot be stored. '
          + 'You are probably re-submitting a response body: restore the original {$env.} reference '
          + 'or supply the real value.',
      }];
    }

    const looksLikeRef = ENV_REF_PREFIX.test(value);
    if (!looksLikeRef || isEnvRef(value)) return [];
    return [{
      path,
      value,
      message: 'Malformed {$env.} reference — expected {$env.NAME} where NAME matches [A-Za-z_][A-Za-z0-9_]*',
    }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, i) => collectEnvRefIssues(item, [...path, String(i)]));
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => collectEnvRefIssues(child, [...path, key]));
  }

  return [];
}
