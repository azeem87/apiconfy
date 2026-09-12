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
