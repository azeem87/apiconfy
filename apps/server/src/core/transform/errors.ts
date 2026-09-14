export class ExpressionSyntaxError extends Error {
  constructor(
    public readonly expression: string,
    message: string,
    public readonly position: number = 0
  ) {
    super(`Invalid expression at position ${position}: ${message} — "${expression}"`);
    this.name = 'ExpressionSyntaxError';
  }
}
