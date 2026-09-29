import { ExpressionSyntaxError } from './errors.js';

/**
 * Compile-only check: the wrapper is built and **never called**, so no operator code runs while
 * the registration request is being validated (script-component.md §3.3). Whether the source is
 * actually a function is decided in the worker, where evaluation is safe (§D4).
 */
export function assertValidScriptExpression(source: string): void {
  try {
    new Function(`return (${source}\n)`);
  } catch (error) {
    throw new ExpressionSyntaxError(
      source,
      error instanceof Error ? error.message : 'invalid expression'
    );
  }
}
