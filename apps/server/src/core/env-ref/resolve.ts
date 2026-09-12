import { parseEnvRef } from './parse.js';
import { AppError } from '@/lib/errors.js';

export class EnvRefResolutionError extends AppError {
  constructor(variableName: string, path: string[]) {
    super(
      `Environment variable "${variableName}" referenced at config.${path.join('.')} is not set`,
      'ENV_REF_UNRESOLVED',
      500,
      { variableName, path }
    );
  }
}

/**
 * Replaces every `$env.NAME` with process.env.NAME.
 * Written and tested in Phase 1 but not called by it — Phase 2 consumes it.
 */
export function resolveEnvRefs<T>(
  value: T,
  env: Record<string, string | undefined> = process.env,
  path: string[] = []
): T {
  const variableName = parseEnvRef(value);
  if (variableName !== null) {
    const resolved = env[variableName];
    if (resolved === undefined) throw new EnvRefResolutionError(variableName, path);
    return resolved as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => resolveEnvRefs(item, env, [...path, String(i)])) as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveEnvRefs(child, env, [...path, key]);
    }
    return out as unknown as T;
  }

  return value;
}
