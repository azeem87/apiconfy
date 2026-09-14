/** Shared data-bag view, independent of the runtime. */
export interface ExpressionScope {
  context: Record<string, unknown>;
  response: unknown;
}
