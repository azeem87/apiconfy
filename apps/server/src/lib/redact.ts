const DEFAULT_SENSITIVE_KEYS = [
  'password', 'passwd', 'secret', 'token', 'key',
  'apiKey', 'api_key', 'apiSecret', 'api_secret',
  'clientSecret', 'client_secret', 'privateKey', 'private_key',
  'accessToken', 'access_token', 'refreshToken', 'refresh_token',
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'passphrase',
];

export function redactSensitiveFields<T>(
  obj: T,
  sensitiveKeys: string[] = DEFAULT_SENSITIVE_KEYS
): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => redactSensitiveFields(item, sensitiveKeys)) as unknown as T;
  }
  const result = { ...obj } as Record<string, unknown>;
  for (const [key, value] of Object.entries(result)) {
    if (sensitiveKeys.some(sensitive => sensitive.toLowerCase() === key.toLowerCase())) {
      result[key] = '***';
    } else if (value !== null && typeof value === 'object') {
      result[key] = redactSensitiveFields(value, sensitiveKeys);
    }
  }
  return result as unknown as T;
}

/** Scrub values even under innocent keys or inside serialized bodies and URLs. */
export function scrubSecretValues<T>(value: T, secrets: readonly string[]): T {
  // A secret this long or longer cannot plausibly be an unrelated word's substring, so it is
  // scrubbed wherever it appears (including glued to other alphanumerics, e.g. "abc12xyz").
  // Shorter secrets (e.g. a 1-char `$env.` value) are word-boundary-guarded instead: they are
  // still scrubbed as a delimited token, but never eat into an unrelated word that merely
  // contains them as a substring (e.g. "e" inside "response").
  const MIN_BOUNDARY_FREE_LENGTH = 6;
  const variants = [...new Set(secrets.filter(Boolean).flatMap(secret => [
    secret,
    encodeURIComponent(secret),
    new URLSearchParams({ value: secret }).toString().slice(6),
    JSON.stringify(secret).slice(1, -1),
  ]))].sort((left, right) => right.length - left.length);
  if (variants.length === 0) return value;
  const alternatives = variants.map(secret => {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return secret.length >= MIN_BOUNDARY_FREE_LENGTH
      ? escaped
      : `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`;
  });
  const pattern = new RegExp(alternatives.join('|'), 'g');
  function walk(node: unknown): unknown {
    if (typeof node === 'string') return node.replace(pattern, '***');
    if ((typeof node === 'number' || typeof node === 'boolean') && secrets.includes(String(node))) return '***';
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(
        ([key, child]) => [key.replace(pattern, '***'), walk(child)]
      ));
    }
    return node;
  }
  return walk(value) as T;
}

/** Capture credential-shaped values before mappings can move them under unrelated keys. */
export function collectSensitiveValues(value: unknown): string[] {
  const secrets = new Set<string>();
  function walk(node: unknown, sensitive = false): void {
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        walk(child, sensitive || DEFAULT_SENSITIVE_KEYS.some(candidate => candidate.toLowerCase() === key.toLowerCase()));
      }
      return;
    }
    if (sensitive && node !== null && node !== undefined && String(node).length > 0) {
      secrets.add(String(node));
    }
  }
  walk(value);
  return [...secrets];
}
