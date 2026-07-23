const DEFAULT_SENSITIVE_KEYS = [
  'password', 'passwd', 'secret', 'token', 'key',
  'apiKey', 'api_key', 'apiSecret', 'api_secret',
  'clientSecret', 'client_secret', 'privateKey', 'private_key',
  'accessToken', 'access_token', 'refreshToken', 'refresh_token',
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
    if (sensitiveKeys.includes(key)) {
      result[key] = '***';
    } else if (value !== null && typeof value === 'object') {
      result[key] = redactSensitiveFields(value, sensitiveKeys);
    }
  }
  return result as unknown as T;
}
