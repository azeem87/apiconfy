import { describe, it, expect } from 'bun:test';
import {
  evaluatePredicate, parseExpression, assertValidExpression, assertValidPath,
  firstPathOperand, ExpressionSyntaxError, type ExpressionScope,
} from '@/core/transform/index.js';

const scope: ExpressionScope = {
  context: {
    id: 42, amount: 250, stringAmount: '250', status: 'active', email: 'a@b.com',
    flag: false, none: null, undef: undefined, zero: 0, empty: '', items: [{ sku: 'A-1' }],
  },
  response: { status: false, code: 500, altId: 7 },
};

describe('evaluatePredicate', () => {
  it.each([
    ['$.context.id != null', true],
    ['$.context.none != null', false],
    ['$.context.missing != null', false],
    ['$.context.amount > 100', true],
    ['$.context.stringAmount > 100', false],
    ["$.context.status == 'active'", true],
    ['$.context.status == "active"', true],
    ["$.context.status == 'inactive'", false],
    ['$.context.email exists', true],
    ['$.context.none exists', false],
    ['$.context.missing exists', false],
    ['$.response.status == false && $.response.code != 200', true],
    ['$.response.id != null || $.response.altId != null', true],
    ['!$.context.flag', true],
    ['$.context.undef == null', true],
    ['$.context.undef != null', false],
    ['$.context.undef exists', false],
    ['$.context.items[10] == null', true],
    ['$.context.id.x == null', true],
    ['$.context.toString == null', true],
    ['$.context.items[0].sku == "A-1"', true],
    ['"42" == 42', false],
    ['"42" != 42', true],
    ['"5" > 5', false],
    ['null > 1', false],
    ['true >= true', false],
    ['$.context == $.context', true],
    ['$.context > $.context', false],
    ['$.context.zero', true],
    ['$.context.empty', true],
    ['$.context.flag', false],
    ['$.context.none', false],
    ['$.context.undef', false],
    ['$.context.missing', false],
    ['$.context.items', true],
    ['$.context', true],
    ['$.response', true],
    ['false exists', true],
    ['0 exists', true],
    ['"" exists', true],
    ['null exists', false],
    ['-1.5 < 0', true],
    ['2 >= 2', true],
    ['1 <= 2', true],
    ['"b" > "a"', true],
    ['"b" >= "b"', true],
    ['"a" < "b"', true],
    ['"a" <= "a"', true],
    ['false || true && false', false],
    ['true || false && false', true],
    ['(true || false) && false', false],
    ['!false && false', false],
    ['!!false', false],
    ['!($.context.id == 42 || false)', false],
    ['!$.context.id == 0', true],
    ['($.context.id == 42) == true', true],
  ] as const)('%s → %s', (expression, expected) => {
    expect(evaluatePredicate(expression, scope)).toBe(expected);
  });

  it('normalizes absent response paths without throwing', () => {
    expect(evaluatePredicate('$.response.id != null', { context: {}, response: null })).toBe(false);
  });

  it('short circuits both logical operators', () => {
    const throwingScope = {
      context: { get unreachable() { throw new Error('must not read'); } },
      response: null,
    };
    expect(evaluatePredicate('true || $.context.unreachable', throwingScope)).toBe(true);
    expect(evaluatePredicate('false && $.context.unreachable', throwingScope)).toBe(false);
  });
});

describe('expression syntax', () => {
  it.each([
    '', ' ', '(', '(true', 'true)', 'true &&', 'true ||', '!', 'bogus', 'toString', 'constructor',
    '$.foo.bar', '$.contextual', '$env.NAME', 'context.id', '$.context.', '$.context..id',
    '$.context.items[*]', '$.context.items[-1]', '$.context.items[0]id',
    '$.context.id =~ "x"', '$.context.id === 42', '1 < 2 < 3', 'true false', '"unclosed', "'unclosed",
    'true & false', 'true | false', '1 + 1', '-', 'true exists exists', 'undefined', 'null()', '1e3',
  ])('rejects %s with a syntax error', (source) => {
    expect(() => parseExpression(source)).toThrow(ExpressionSyntaxError);
    expect(() => assertValidExpression(source)).toThrow(ExpressionSyntaxError);
    expect(() => evaluatePredicate(source, scope)).toThrow(ExpressionSyntaxError);
  });

  it('returns an AST without evaluating and retains source positions on errors', () => {
    expect(assertValidExpression('$.context.missing > 1')).toBeUndefined();
    expect(parseExpression('!$.context.id == 0').kind).toBe('not');
    try {
      assertValidExpression('true &&');
      throw new Error('Expected syntax error');
    } catch (error) {
      expect(error).toBeInstanceOf(ExpressionSyntaxError);
      expect((error as ExpressionSyntaxError).expression).toBe('true &&');
      expect((error as ExpressionSyntaxError).position).toBe(7);
      expect((error as Error).name).toBe('ExpressionSyntaxError');
    }
  });

  it.each(['$.context', '$.response', '$.context.items[0].sku', '$.response.error.message'])(
    'accepts value path %s', (source) => {
      expect(assertValidPath(source)).toBeUndefined();
    }
  );

  it.each(['', ' ', '$.context.', '$.response[*]', '$.foo', 'true', '$.response.id != null'])(
    'rejects invalid errorPath %s', (source) => {
      expect(() => assertValidPath(source)).toThrow(ExpressionSyntaxError);
    }
  );
});

describe('firstPathOperand', () => {
  it.each([
    ['$.response.a != null && $.response.b', '$.response.a'],
    ['true || (false && $.response.b)', '$.response.b'],
    ['!($.context.email exists)', '$.context.email'],
    ['true == ($.context.flag)', '$.context.flag'],
    ['"$.response.literal" == "x"', null],
    ['true', null],
  ] as const)('finds first path in %s', (source, expected) => {
    expect(firstPathOperand(source)).toBe(expected);
  });
});
