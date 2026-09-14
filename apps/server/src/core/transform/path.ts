export type PathSegment =
  | { kind: 'key'; value: string }
  | { kind: 'index'; value: number };

export interface PathLookup {
  found: boolean;
  value: unknown;
}

const KEY_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/y;
const INDEX_PATTERN = /\[([0-9]+)\]/y;

/** Parses only whole-string paths; unsupported syntax remains a template literal. */
export function parsePath(source: string): PathSegment[] | null {
  if (!source.startsWith('$.')) return null;

  const segments: PathSegment[] = [];
  let cursor = 2;
  let expectKey = true;

  while (cursor < source.length) {
    if (expectKey) {
      KEY_PATTERN.lastIndex = cursor;
      const key = KEY_PATTERN.exec(source);
      if (!key) return null;
      segments.push({ kind: 'key', value: key[0] });
      cursor = KEY_PATTERN.lastIndex;
      expectKey = false;
      continue;
    }

    if (source[cursor] === '.') {
      cursor += 1;
      expectKey = true;
      continue;
    }

    INDEX_PATTERN.lastIndex = cursor;
    const index = INDEX_PATTERN.exec(source);
    if (!index) return null;
    segments.push({ kind: 'index', value: Number(index[1]) });
    cursor = INDEX_PATTERN.lastIndex;
  }

  return expectKey ? null : segments;
}

/** Missing keys, array holes and inherited properties never resolve. */
export function lookupPath(root: unknown, segments: PathSegment[]): PathLookup {
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return { found: false, value: undefined };
    }
    if (segment.kind === 'index' && (
      !Array.isArray(current) || !Number.isSafeInteger(segment.value) ||
      segment.value < 0 || segment.value >= current.length
    )) {
      return { found: false, value: undefined };
    }
    if (!Object.hasOwn(current, segment.value)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string | number, unknown>)[segment.value];
  }
  return { found: true, value: current };
}
