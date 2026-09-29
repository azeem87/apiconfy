import type { InvocationFailure } from '@/core/types.js';
import { AppError } from '@/lib/errors.js';

/** Response envelopes from api-routes.md. One definition, so no route can drift. */

export interface Envelope<T> {
  success: true;
  data: T;
  meta: Record<string, unknown>;
}

/** Single resource or unpaginated list — `meta` is `{}` per api-routes.md. */
export function ok<T>(data: T): Envelope<T> {
  return { success: true, data, meta: {} };
}

/** Paginated list — `total` is the filtered count, not the page length. */
export function okPaged<T>(
  items: T[],
  meta: { total: number; limit: number; offset: number }
): Envelope<T[]> {
  return { success: true, data: items, meta };
}

/**
 * Build the invoke route's failure envelope from any thrown value. Shared with the script bridge
 * (`core/runtime/script-bridge.ts`) so a nested invoke failure is indistinguishable from an HTTP one.
 */
export function toInvocationFailure(
  caught: unknown,
  executionId: string,
  startedAtMs: number
): InvocationFailure {
  const error = caught instanceof AppError
    ? caught
    : new AppError('Internal server error', 'INTERNAL_ERROR');
  return {
    success: false,
    data: null,
    error: { code: error.code, message: error.message, details: error.details },
    meta: { executionId, durationMs: Date.now() - startedAtMs },
  };
}
