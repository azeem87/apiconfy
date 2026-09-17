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
 * Replaces every `{$env.NAME}` with process.env.NAME.
 * A thin wrapper over `resolveEnvRefsDetailed` for callers that don't need the
 * resolved secret values back (e.g. registration-time dry-run validation).
 */
export function resolveEnvRefs<T>(
  value: T,
  env: Record<string, string | undefined> = process.env
): T {
  return resolveEnvRefsDetailed(value, env).config;
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
