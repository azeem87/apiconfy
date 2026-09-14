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
    return Object.fromEntries(Object.entries(value).map(
      ([key, child]) => [key, resolveEnvRefs(child, env, [...path, key])]
    )) as T;
  }

  return value;
}

/** Resolve and capture in one walk; values are private to the invocation's sanitizer. */
export function resolveEnvRefsDetailed<T>(
  value: T,
  env: Record<string, string | undefined> = process.env,
  onSecret?: (secret: string) => void
): { config: T; secrets: string[] } {
  const secrets = new Set<string>();
  function walk(node: unknown, path: string[]): unknown {
    const name = parseEnvRef(node);
    if (name !== null) {
      const resolved = env[name];
      if (resolved === undefined) throw new EnvRefResolutionError(name, path);
      if (resolved.length > 0 && !secrets.has(resolved)) {
        secrets.add(resolved);
        onSecret?.(resolved);
      }
      return resolved;
    }
    if (Array.isArray(node)) return node.map((item, index) => walk(item, [...path, String(index)]));
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(
        ([key, child]) => [key, walk(child, [...path, key])]
      ));
    }
    return node;
  }
  return { config: walk(value, []) as T, secrets: [...secrets] };
}
