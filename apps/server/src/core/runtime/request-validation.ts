import type { ValidationField, ValidationFieldType } from '@/core/types.js';
import { TransformationError } from '@/lib/errors.js';

export type FieldSegment =
  | { kind: 'key'; value: string }
  | { kind: 'quoted'; value: string }
  | { kind: 'index'; value: number }
  | { kind: 'wildcard' };

export interface FieldFailure {
  path: Array<string | number>;
  message: string;
}

const KEY_PATTERN = /[A-Za-z_$][A-Za-z0-9_]*/y;
const INDEX_PATTERN = /\[([0-9]+)\]/y;
const WILDCARD_PATTERN = /\[\*\]/y;
const QUOTED_PATTERN = /\["([^"]+)"\]/y;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_]*$/;

/** Payload-relative field path: dotted keys, `[n]` indices, `[*]` wildcard, `["quoted key"]` segments. */
export function parseFieldPath(source: string): FieldSegment[] | null {
  if (source.length === 0) return null;
  const segments: FieldSegment[] = [];
  let cursor = 0;
  let expectKey = true;
  while (cursor < source.length) {
    if (expectKey) {
      KEY_PATTERN.lastIndex = cursor;
      const key = KEY_PATTERN.exec(source);
      if (key) {
        segments.push({ kind: 'key', value: key[0] });
        cursor = KEY_PATTERN.lastIndex;
        expectKey = false;
        continue;
      }
      QUOTED_PATTERN.lastIndex = cursor;
      const quoted = QUOTED_PATTERN.exec(source);
      if (quoted) {
        segments.push({ kind: 'quoted', value: quoted[1] });
        cursor = QUOTED_PATTERN.lastIndex;
        expectKey = false;
        continue;
      }
      return null;
    }
    if (source[cursor] === '.') {
      cursor += 1;
      expectKey = true;
      continue;
    }
    INDEX_PATTERN.lastIndex = cursor;
    const index = INDEX_PATTERN.exec(source);
    if (index) {
      segments.push({ kind: 'index', value: Number(index[1]) });
      cursor = INDEX_PATTERN.lastIndex;
      continue;
    }
    WILDCARD_PATTERN.lastIndex = cursor;
    if (WILDCARD_PATTERN.exec(source)) {
      segments.push({ kind: 'wildcard' });
      cursor = WILDCARD_PATTERN.lastIndex;
      continue;
    }
    QUOTED_PATTERN.lastIndex = cursor;
    const quoted = QUOTED_PATTERN.exec(source);
    if (quoted) {
      segments.push({ kind: 'quoted', value: quoted[1] });
      cursor = QUOTED_PATTERN.lastIndex;
      continue;
    }
    return null;
  }
  return expectKey ? null : segments;
}

function formatSegment(segment: FieldSegment, first: boolean): string {
  if (segment.kind === 'index') return `[${segment.value}]`;
  if (segment.kind === 'wildcard') return '[*]';
  const identifier = segment.kind === 'key' && IDENTIFIER_PATTERN.test(segment.value);
  return identifier ? (first ? segment.value : `.${segment.value}`) : `["${segment.value}"]`;
}

function formatPath(path: FieldSegment[]): string {
  return path.map((segment, index) => formatSegment(segment, index === 0)).join('');
}

function pathValues(path: FieldSegment[]): Array<string | number> {
  return path.map(segment => (segment.kind === 'wildcard' ? '*' : segment.value));
}

function matchesType(type: ValidationFieldType, value: unknown, found: boolean): boolean {
  if (!found) return false;
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

function checkTarget(
  field: ValidationField, value: unknown, found: boolean, path: FieldSegment[]
): FieldFailure | null {
  const missing = !found || value === null || value === undefined;
  if (field.required === true && missing) {
    return { path: pathValues(path), message: field.message ?? `${formatPath(path)} is required` };
  }
  if (field.type !== undefined && !matchesType(field.type, value, found)) {
    const article = field.type === 'array' || field.type === 'object' || field.type === 'integer' ? 'an' : 'a';
    return {
      path: pathValues(path),
      message: field.message ?? `${formatPath(path)} must be ${article} ${field.type}`,
    };
  }
  if (field.minItems !== undefined && (!Array.isArray(value) || value.length < field.minItems)) {
    const entries = field.minItems === 1 ? 'entry' : 'entries';
    return {
      path: pathValues(path),
      message: field.message ?? `${formatPath(path)} must contain at least ${field.minItems} ${entries}`,
    };
  }
  if (field.minLength !== undefined && (typeof value !== 'string' || value.length < field.minLength)) {
    const characters = field.minLength === 1 ? 'character' : 'characters';
    return {
      path: pathValues(path),
      message: field.message ?? `${formatPath(path)} must have at least ${field.minLength} ${characters}`,
    };
  }
  return null;
}

function walkTargets(
  segments: FieldSegment[], field: ValidationField, value: unknown, found: boolean, path: FieldSegment[]
): FieldFailure | null {
  const [segment, ...rest] = segments;
  if (segment === undefined) return checkTarget(field, value, found, path);
  if (segment.kind === 'wildcard') {
    if (!found || !Array.isArray(value)) {
      return {
        path: [...pathValues(path), '*'],
        message: field.message ?? `${formatPath(path)} must be an array`,
      };
    }
    for (let index = 0; index < value.length; index += 1) {
      const failure = walkTargets(rest, field, value[index], true, [...path, { kind: 'index', value: index }]);
      if (failure) return failure;
    }
    return null;
  }
  let nextFound = false;
  let next: unknown;
  if (found && value !== null && typeof value === 'object') {
    if (segment.kind === 'index') {
      if (Array.isArray(value) && segment.value < value.length && Object.hasOwn(value, segment.value)) {
        next = value[segment.value];
        nextFound = true;
      }
    } else if (Object.hasOwn(value, segment.value)) {
      next = (value as Record<string, unknown>)[segment.value];
      nextFound = true;
    }
  }
  return walkTargets(rest, field, next, nextFound, [...path, segment]);
}

/**
 * Evaluates payload field constraints in config order.
 * First failing constraint per field; wildcards report the first failing element only.
 */
export function collectFieldFailures(
  fields: ValidationField[], payload: Record<string, unknown>
): FieldFailure[] {
  const failures: FieldFailure[] = [];
  for (const field of fields) {
    const segments = parseFieldPath(field.path);
    if (!segments) throw new TransformationError(`Stored validation path is invalid: ${field.path}`);
    const failure = walkTargets(segments, field, payload, true, []);
    if (failure) failures.push(failure);
  }
  return failures;
}
