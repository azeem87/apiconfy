export interface ExpressionScope {
  context: Record<string, unknown>;
  env: Record<string, string>;
  output: unknown;
}
