import { isEnvRef, MASK } from './parse.js';

/**
 * Replaces every well-formed `$env.NAME` string with `****`, anywhere in the structure.
 *
 * Value-driven, not field-name-driven. Pure: returns a new structure, never mutates input.
 */
export function maskEnvRefs<T>(value: T): T {
  if (isEnvRef(value)) return MASK as unknown as T;

  if (Array.isArray(value)) {
    return value.map((item) => maskEnvRefs(item)) as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskEnvRefs(child);
    }
    return out as unknown as T;
  }

  return value;
}
