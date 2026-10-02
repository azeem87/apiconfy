import { z } from 'zod';
import { assertValidExpression, assertValidPath } from '@/core/transform/index.js';
import { collectTemplateIssues } from '@/core/transform/template-validation.js';
import { parseFieldPath } from '@/core/runtime/request-validation.js';
import { isEnvRef } from '@/core/env-ref/index.js';
import { hasSelfSignedRoot, isCertificateMaterial, isPrivateKeyPem } from '@/lib/tls-material.js';

export const TimeoutConfigSchema = z.object({
  connectTimeout: z.number().int().positive().optional(),
  readTimeout: z.number().int().positive().max(120_000).optional(),
  requestTimeout: z.number().int().positive().max(120_000).optional(),
}).strict();

export const CircuitBreakerConfigSchema = z.object({
  failureThreshold: z.number().int().positive(),
  windowSize: z.number().int().positive(),
  openDuration: z.number().int().positive(),
  halfOpenMaxAttempts: z.number().int().positive(),
}).strict();

export const ResilienceConfigSchema = z.object({
  retryCount: z.number().int().min(0).max(10).optional(),
  retryDelay: z.number().int().positive().optional(),
  backoff: z.enum(['fixed', 'exponential']).optional(),
  maxElapsedTime: z.number().int().positive().max(300_000).optional(),
  retryOn: z.array(z.number().int()).optional(),
  circuitBreaker: CircuitBreakerConfigSchema.optional(),
}).strict();

export const ValidationRuleSchema = z.object({
  expression: z.string().min(1),
  message: z.string().optional(),
  errorPath: z.string().optional(),
}).strict();

/** Standalone path expression validator for use in schemas (e.g. errorPath fields). */
export function pathExpression() {
  return z.string().min(1).refine((value) => {
    try { assertValidPath(value); return true; } catch { return false; }
  }, 'Invalid path expression');
}

const OUTPUT_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export const OutputConfigSchema = z.object({
  key: z.string().regex(OUTPUT_KEY_PATTERN, 'output.key must be alphanumeric (letters, digits, underscores) and start with a letter').optional(),
  transformation: z.record(z.unknown()).optional(),
  validation: z.object({
    rules: z.array(ValidationRuleSchema).optional(),
  }).strict().optional(),
  default: z.record(z.unknown()).optional(),
}).strict().superRefine((config, ctx) => {
  if (!config.key && !config.transformation && !config.validation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'output must contain at least one of: key, validation, transformation',
    });
  }
  for (const issue of collectTemplateIssues(config.transformation ?? {}, ['transformation'])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: issue.path,
      message: `${issue.message} (at "${issue.value}")`,
    });
  }
  for (const [index, rule] of (config.validation?.rules ?? []).entries()) {
    for (const [field, validate] of [
      ['expression', assertValidExpression],
      ['errorPath', assertValidPath],
    ] as const) {
      const source = rule[field];
      if (source === undefined) continue;
      try {
        validate(source);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['validation', 'rules', index, field],
          message: error instanceof Error ? error.message : 'Invalid expression',
        });
      }
    }
  }
});

const PAYLOAD_RUNTIME_ROOTS = new Set(['context', 'output', 'env']);

export const ValidationFieldSchema = z.object({
  path: z.string().min(1),
  required: z.boolean().optional(),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object']).optional(),
  minItems: z.number().int().min(1).optional(),
  minLength: z.number().int().min(1).optional(),
  message: z.string().min(1).optional(),
}).strict();

/**
 * Shared payload-validation block: one definition, per-component placement.
 * REST nests it under `config.request.validation`; flat configs declare it at config level.
 */
export const RequestValidationSchema = z.object({
  fields: z.array(ValidationFieldSchema).min(1),
}).strict().superRefine((validation, ctx) => {
  validation.fields.forEach((field, index) => {
    const at = (...suffix: Array<string | number>) => ['fields', index, ...suffix];
    if (field.required === undefined && field.type === undefined
      && field.minItems === undefined && field.minLength === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at(),
        message: 'field must declare at least one of: required, type, minItems, minLength',
      });
    }
    if (field.minItems !== undefined && field.type !== 'array') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: at('minItems'), message: 'minItems requires type "array"',
      });
    }
    if (field.minLength !== undefined && field.type !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: at('minLength'), message: 'minLength requires type "string"',
      });
    }
    if (field.path.startsWith('{$')) {
      const inner = field.path.startsWith('{$context.') && field.path.endsWith('}')
        ? field.path.slice('{$context.'.length, -1)
        : null;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at('path'),
        message: inner && parseFieldPath(inner)
          ? `write the payload field path directly — "${inner}", not "${field.path}"`
          : 'write the payload field path directly, without {$...} expressions',
      });
      return;
    }
    const segments = parseFieldPath(field.path);
    if (!segments) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: at('path'), message: 'invalid field path' });
      return;
    }
    const first = segments[0];
    if (first?.kind === 'key' && PAYLOAD_RUNTIME_ROOTS.has(first.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: at('path'),
        message: `"${first.value}" is a runtime namespace, not a payload field — write the payload path directly, or quote it (["${first.value}"].…) if the payload really has that key`,
      });
    }
  });
});

export const SSLConfigSchema = z.object({
  ca: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  cert: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  passphrase: z.string().optional(),
  disableSSL: z.boolean().optional(),
}).strict().superRefine((ssl, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  const hasIdentity = ssl.cert !== undefined && ssl.key !== undefined;
  if (ssl.disableSSL === true && (ssl.ca !== undefined || ssl.cert !== undefined || ssl.key !== undefined)) {
    issue('disableSSL', 'disableSSL: true cannot be combined with `ca`, `cert` or `key`');
  }
  if (ssl.ca === undefined && ssl.cert === undefined && ssl.key === undefined && ssl.disableSSL !== true) {
    issue('ca', 'ssl needs `ca` (server trust), `cert`+`key` (client identity) or `disableSSL: true`');
  }
  if ((ssl.cert === undefined) !== (ssl.key === undefined)) {
    issue(ssl.cert === undefined ? 'cert' : 'key', 'cert and key go together (mTLS)');
  }
  if (ssl.passphrase !== undefined && ssl.key === undefined) issue('passphrase', 'passphrase requires key');
  // `{$env.NAME}` values are resolved at invocation, so only inline material can be checked here.
  const entriesOf = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
  const certMessage = 'expected PEM (-----BEGIN CERTIFICATE-----), base64-encoded DER (.cer) or a {$env.NAME} reference';
  for (const field of ['ca', 'cert'] as const) {
    const value = ssl[field];
    if (value === undefined) continue;
    const inlineEntries = entriesOf(value).filter(entry => !isEnvRef(entry));
    if (inlineEntries.length > 0 && !isCertificateMaterial(inlineEntries)) issue(field, certMessage);
  }
  if (ssl.ca !== undefined) {
    const allEntries = entriesOf(ssl.ca);
    const inlineEntries = allEntries.filter(entry => !isEnvRef(entry));
    const isFullyInline = inlineEntries.length === allEntries.length;
    if (isFullyInline && isCertificateMaterial(inlineEntries) && !hasSelfSignedRoot(inlineEntries)) {
      issue('ca', 'ca must include the root CA certificate (self-signed) of the server chain — a lone server or intermediate certificate is not trusted (unlike a Java keystore). Add the issuing chain up to the root');
    }
  }
  if (hasIdentity && ssl.key !== undefined && !isEnvRef(ssl.key) && !isPrivateKeyPem(ssl.key)) {
    issue('key', 'expected PEM private key (PKCS#8/PKCS#1/EC) or a {$env.NAME} reference; convert with `openssl pkcs8 -topk8 -nocrypt -in key.der -inform DER`');
  }
});

const BASIC_USERNAME_MESSAGE = 'username must not contain ":" — it is the Basic credential separator (RFC 7617)';

export const BasicAuthSchema = z.object({
  username: z.string().min(1).refine((value) => !value.includes(':'), { message: BASIC_USERNAME_MESSAGE }),
  password: z.string().min(1),
}).strict();

// Client credentials travel over `accessTokenUri` and RFC 6749 §2.3.1 requires TLS, so the URI must
// be https (a {$env.NAME} reference is resolved and re-checked at invoke, like ssl material).
// `disableSSL` means "do not verify the certificate", never "send it in cleartext".
const httpsAccessTokenUri = z.string().min(1).superRefine((value, ctx) => {
  if (isEnvRef(value) || /^https:\/\//i.test(value)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'accessTokenUri must be an absolute https:// URL or a {$env.NAME} reference',
  });
});

// RFC 6749 §3.3: scope = scope-token *( SP scope-token )
//                scope-token = 1*( %x21 / %x23-5B / %x5D-7E ) — no space, quote or backslash.
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const scopeSchema = z.string().min(1).refine(
  (value) => value.split(' ').every((token) => SCOPE_TOKEN_PATTERN.test(token)),
  {
    message:
      'scope must be single-space-delimited tokens containing no quotes, backslashes or other whitespace (RFC 6749 §3.3)',
  }
);

export const OAuth2ConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  accessTokenUri: httpsAccessTokenUri,
  scope: scopeSchema.optional(),
  /** How clientId/clientSecret reach the token endpoint. Default 'basic' (RFC 6749 §2.3.1). */
  clientAuth: z.enum(['basic', 'body']).optional(),
  /** IdP-specific extra token-request parameter (e.g. Okta's `audience`). */
  audience: z.string().min(1).optional(),
}).strict();

const RESERVED_BODY_KEYS = new Set(['username', 'password', 'client_secret']);

export const JwtExternalConfigSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  credentialPlacement: z.enum(['header', 'body']).optional(),
  accessTokenUri: httpsAccessTokenUri,
  contentType: z.string().min(1).optional(),
  requestBody: z.record(z.unknown()).optional(),
  responsePath: z.string().min(1).optional(),
  requestHeader: z.string().min(1).optional(),
  tokenPrefix: z.string().optional(),
}).strict().superRefine((config, ctx) => {
  // The credentials come from the fields above; a duplicate in requestBody hides which one wins.
  const redefinesCredentials = Object.keys(config.requestBody ?? {})
    .some((key) => RESERVED_BODY_KEYS.has(key.toLowerCase()));
  if (redefinesCredentials) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestBody'],
      message: 'requestBody must not redefine username, password or client_secret — use the block fields',
    });
  }
  // This block carries username/password and rejects `client_secret` above, so a client_credentials
  // grant can never authenticate here — that shape is the oauth2 block's job.
  const grantType = Object.entries(config.requestBody ?? {})
    .find(([key]) => key.toLowerCase() === 'grant_type')?.[1];
  if (typeof grantType === 'string' && grantType.toLowerCase() === 'client_credentials') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestBody'],
      message: 'grant_type "client_credentials" belongs in the oauth2 block (clientId/clientSecret, clientAuth "basic" or "body") — jwt.external is the password/bespoke shape',
    });
  }
  // Only explicit header placement builds a Basic header. The default is 'body', where the username
  // is a form-encoded value and ':' is legal.
  if (config.credentialPlacement === 'header' && config.username.includes(':')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['username'], message: BASIC_USERNAME_MESSAGE });
  }
});

/** RFC 7518 §3.1 — an HMAC key MUST be at least the hash output size. */
const MIN_HS_KEY_BYTES = 32;

export const JwtLocalConfigSchema = z.object({
  algorithm: z.enum(['HS256', 'HS384', 'HS512', 'RS256']),
  secretOrPrivateKey: z.string().min(1),
  /** Without claims and expiresInSeconds the signed JWT carries no `exp`; most IdPs reject that. */
  claims: z.object({
    issuer: z.string().min(1).optional(),
    audience: z.string().min(1).optional(),
    subject: z.string().min(1).optional(),
  }).strict().optional(),
  expiresInSeconds: z.number().int().positive().optional(),
  requestHeader: z.string().min(1).optional(),
  tokenPrefix: z.string().optional(),
}).strict().superRefine((config, ctx) => {
  const key = config.secretOrPrivateKey;
  if (isEnvRef(key)) return;
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['secretOrPrivateKey'], message });
  if (config.algorithm.startsWith('HS')) {
    if (Buffer.byteLength(key, 'utf8') < MIN_HS_KEY_BYTES) {
      issue(`an HS* signing key must be at least ${MIN_HS_KEY_BYTES} bytes (RFC 7518 §3.1)`);
    }
  } else if (!isPrivateKeyPem(key)) {
    issue('an RS256 signing key must be a PEM private key or a {$env.NAME} reference');
  }
});

export const AuthConfigSchema = z.object({
  /** Token-endpoint TLS — a different host from `request.uri`. Reuses SSLConfigSchema, which already carries `disableSSL`. */
  ssl: SSLConfigSchema.optional(),
  basic: BasicAuthSchema.optional(),
  oauth2: OAuth2ConfigSchema.optional(),
  jwt: z.object({
    external: JwtExternalConfigSchema.optional(),
    local: JwtLocalConfigSchema.optional(),
  }).strict().refine(
    (jwt) => [jwt.external, jwt.local].filter(Boolean).length === 1,
    { message: 'jwt requires exactly one of external or local' }
  ).optional(),
}).strict().refine(
  (auth) => [auth.basic, auth.oauth2, auth.jwt].filter(Boolean).length <= 1,
  { message: 'Only one of basic, oauth2, or jwt may be configured' }
).refine(
  (auth) => !auth.ssl || auth.oauth2 || auth.jwt?.external,
  { path: ['ssl'], message: 'auth.ssl applies to the token endpoint — it needs oauth2 or jwt.external' }
);
