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
  return {
    success: false,
    data: null,
    error: toInvokeErrorResponse(caught).body.error,
    meta: { executionId, durationMs: Date.now() - startedAtMs },
  };
}

/**
 * The error body every invoke-style route returns: `{ error: { code, message, details } }`, with
 * an upstream failure's `downstream` wrapper replaced by its `body`, placed directly in `details`. The status surfaces the
 * upstream's own status (e.g. 401/422) instead of the gateway's generic 502.
 */
export function toInvokeErrorResponse(caught: unknown): {
  status: number;
  body: { error: { code: string; message: string; details: unknown } };
} {
  const appError = caught instanceof AppError ? caught : new AppError('Internal server error', 'INTERNAL_ERROR');
  const downstream = appError.code === 'EXTERNAL_ERROR'
    ? (appError.details as { downstream?: { status?: number; body?: unknown } } | undefined)?.downstream
    : undefined;
  return {
    status: downstream?.status ?? appError.statusCode,
    body: {
      error: {
        code: appError.code,
        message: appError.message,
        details: downstream ? downstream.body : appError.details,
      },
    },
  };
}
