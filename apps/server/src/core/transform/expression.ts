import { ExpressionSyntaxError } from './errors.js';
import { lookupPath, parsePath, type PathSegment } from './path.js';
import type { ExpressionScope } from './scope.js';

type TokenType =
  | 'path' | 'number' | 'string' | 'true' | 'false' | 'null' | 'exists'
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'and' | 'or' | 'not'
  | 'lparen' | 'rparen' | 'eof';

interface Token {
  type: TokenType;
  value?: unknown;
  start: number;
}

export type ComparisonOperator = '==' | '!=' | '>' | '>=' | '<' | '<=';

export type ValueNode =
  | { kind: 'path'; expression: string; segments: PathSegment[] }
  | { kind: 'literal'; value: unknown }
  | { kind: 'group'; node: ExpressionNode };

export type ExpressionNode =
  | { kind: 'or' | 'and'; left: ExpressionNode; right: ExpressionNode }
  | { kind: 'not'; operand: ExpressionNode }
  | { kind: 'compare'; operator: ComparisonOperator; left: ValueNode; right: ValueNode }
  | { kind: 'exists'; operand: ValueNode }
  | { kind: 'value'; value: ValueNode };

const KEYWORDS = new Map<string, TokenType>([
  ['true', 'true'], ['false', 'false'], ['null', 'null'], ['exists', 'exists'],
]);
const OPERATORS = new Map<string, TokenType>([
  ['&&', 'and'], ['||', 'or'], ['==', 'eq'], ['!=', 'neq'], ['>=', 'gte'], ['<=', 'lte'],
  ['>', 'gt'], ['<', 'lt'], ['!', 'not'], ['(', 'lparen'], [')', 'rparen'],
]);
const COMPARISONS: Partial<Record<TokenType, ComparisonOperator>> = {
  eq: '==', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=',
};

function hasValidRoot(segments: PathSegment[]): boolean {
  return segments[0]?.kind === 'key' &&
    (segments[0].value === 'context' || segments[0].value === 'response');
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const char = source[cursor];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }

    const two = source.slice(cursor, cursor + 2);
    if (two === '=~') {
      throw new ExpressionSyntaxError(source, 'regex matching (=~) is not supported until Phase 7', cursor);
    }
    const pairOperator = two.length === 2 ? OPERATORS.get(two) : undefined;
    const operator = pairOperator ?? OPERATORS.get(char);
    if (operator) {
      tokens.push({ type: operator, start: cursor });
      cursor += pairOperator ? 2 : 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = source.indexOf(char, cursor + 1);
      if (end === -1) throw new ExpressionSyntaxError(source, 'unterminated string literal', cursor);
      tokens.push({ type: 'string', value: source.slice(cursor + 1, end), start: cursor });
      cursor = end + 1;
      continue;
    }

    if (source.startsWith('$.', cursor)) {
      let end = cursor + 2;
      while (end < source.length && /[A-Za-z0-9_$.[\]]/.test(source[end])) end += 1;
      const expression = source.slice(cursor, end);
      const segments = parsePath(expression);
      if (!segments) throw new ExpressionSyntaxError(source, `"${expression}" is not a valid path`, cursor);
      if (!hasValidRoot(segments)) {
        throw new ExpressionSyntaxError(source, 'path must start with $.context or $.response', cursor);
      }
      tokens.push({ type: 'path', value: { expression, segments }, start: cursor });
      cursor = end;
      continue;
    }

    if (/[0-9-]/.test(char)) {
      const match = /^-?[0-9]+(\.[0-9]+)?/.exec(source.slice(cursor));
      if (!match) throw new ExpressionSyntaxError(source, 'invalid number', cursor);
      tokens.push({ type: 'number', value: Number(match[0]), start: cursor });
      cursor += match[0].length;
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(cursor));
    const keyword = word ? KEYWORDS.get(word[0]) : undefined;
    if (word && keyword) {
      tokens.push({ type: keyword, start: cursor });
      cursor += word[0].length;
      continue;
    }
    throw new ExpressionSyntaxError(source, `unexpected character "${char}"`, cursor);
  }

  tokens.push({ type: 'eof', start: source.length });
  return tokens;
}

/** Parses the predicate grammar without evaluating any data. */
export function parseExpression(source: string): ExpressionNode {
  const tokens = tokenize(source);
  let position = 0;
  const peek = (): Token => tokens[position];
  const next = (): Token => tokens[position++];

  function parseValue(): ValueNode {
    const token = next();
    switch (token.type) {
      case 'path':
        return { kind: 'path', ...(token.value as { expression: string; segments: PathSegment[] }) };
      case 'number':
      case 'string':
        return { kind: 'literal', value: token.value };
      case 'true': return { kind: 'literal', value: true };
      case 'false': return { kind: 'literal', value: false };
      case 'null': return { kind: 'literal', value: null };
      case 'lparen': {
        const node = parseOr();
        if (peek().type !== 'rparen') {
          throw new ExpressionSyntaxError(source, 'expected ")"', peek().start);
        }
        next();
        return { kind: 'group', node };
      }
      default:
        throw new ExpressionSyntaxError(source, `expected a value, found "${token.type}"`, token.start);
    }
  }

  function parseComparison(): ExpressionNode {
    const left = parseValue();
    if (peek().type === 'exists') {
      next();
      return { kind: 'exists', operand: left };
    }
    const operator = COMPARISONS[peek().type];
    if (!operator) return { kind: 'value', value: left };
    next();
    return { kind: 'compare', operator, left, right: parseValue() };
  }

  function parseNot(): ExpressionNode {
    if (peek().type === 'not') {
      next();
      return { kind: 'not', operand: parseNot() };
    }
    return parseComparison();
  }

  function parseAnd(): ExpressionNode {
    let node = parseNot();
    while (peek().type === 'and') {
      next();
      node = { kind: 'and', left: node, right: parseNot() };
    }
    return node;
  }

  function parseOr(): ExpressionNode {
    let node = parseAnd();
    while (peek().type === 'or') {
      next();
      node = { kind: 'or', left: node, right: parseAnd() };
    }
    return node;
  }

  if (tokens.length === 1) throw new ExpressionSyntaxError(source, 'empty expression');
  const root = parseOr();
  if (peek().type !== 'eof') {
    throw new ExpressionSyntaxError(source, `unexpected "${peek().type}"`, peek().start);
  }
  return root;
}

function readValue(node: ValueNode, scope: ExpressionScope): unknown {
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'path') return lookupPath(scope, node.segments).value ?? null;
  return evaluate(node.node, scope);
}

function compare(operator: ComparisonOperator, left: unknown, right: unknown): boolean {
  if (operator === '==') return left === right;
  if (operator === '!=') return left !== right;
  const bothNumbers = typeof left === 'number' && typeof right === 'number';
  const bothStrings = typeof left === 'string' && typeof right === 'string';
  if (!bothNumbers && !bothStrings) return false;
  const a = left as number | string;
  const b = right as number | string;
  if (operator === '>') return a > b;
  if (operator === '>=') return a >= b;
  if (operator === '<') return a < b;
  return a <= b;
}

function evaluate(node: ExpressionNode, scope: ExpressionScope): boolean {
  switch (node.kind) {
    case 'or': return evaluate(node.left, scope) || evaluate(node.right, scope);
    case 'and': return evaluate(node.left, scope) && evaluate(node.right, scope);
    case 'not': return !evaluate(node.operand, scope);
    case 'compare': return compare(node.operator, readValue(node.left, scope), readValue(node.right, scope));
    case 'exists': return readValue(node.operand, scope) != null;
    case 'value': {
      const value = readValue(node.value, scope);
      // Unlike JavaScript, 0 and "" are truthy in this language.
      return value !== false && value != null;
    }
  }
}

export function evaluatePredicate(source: string, scope: ExpressionScope): boolean {
  return evaluate(parseExpression(source), scope);
}

/** First source-order path operand, used to identify a failed validation rule. */
export function firstPathOperand(source: string): string | null {
  function visit(node: ExpressionNode | ValueNode): string | null {
    switch (node.kind) {
      case 'path': return node.expression;
      case 'literal': return null;
      case 'group': return visit(node.node);
      case 'not':
      case 'exists': return visit(node.operand);
      case 'value': return visit(node.value);
      case 'compare':
      case 'or':
      case 'and': return visit(node.left) ?? visit(node.right);
    }
  }
  return visit(parseExpression(source));
}

export function assertValidExpression(source: string): void {
  parseExpression(source);
}

/** A value path (not a predicate), with the same explicit-root rule as expressions. */
export function assertValidPath(source: string): void {
  const segments = parsePath(source);
  if (!segments) throw new ExpressionSyntaxError(source, `"${source}" is not a valid path`);
  if (!hasValidRoot(segments)) {
    throw new ExpressionSyntaxError(source, 'path must start with $.context or $.response');
  }
}
