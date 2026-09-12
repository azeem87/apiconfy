export interface Pagination {
  limit: number;
  offset: number;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * Defaults and bounds from api-routes.md: limit default 20, max 100; offset default 0.
 *
 * Clamps rather than rejects. A `limit=5000` is a client being greedy, not a client being
 * wrong, and 100 rows is a correct answer to it. Garbage input (`limit=abc`) falls back to
 * the default for the same reason — there is a sane response, so 400 buys nothing.
 */
export function parsePagination(query: { limit?: string; offset?: string }): Pagination {
  const parsedLimit = Number.parseInt(query.limit ?? '', 10);
  const parsedOffset = Number.parseInt(query.offset ?? '', 10);

  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  return { limit, offset };
}
