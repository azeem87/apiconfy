import { z } from 'zod';
import { assertValidExpression, assertValidPath } from '@/core/transform/index.js';
import { collectTemplateIssues } from '@/core/transform/template-validation.js';
import { parseFieldPath } from '@/core/runtime/request-validation.js';
import { isEnvRef } from '@/core/env-ref/parse.js';
import { isCertificateMaterial, isPrivateKeyPem } from '@/lib/tls-material.js';

export const TimeoutConfigSchema = z.object({
  connect: z.number().int().positive().optional(),
  socket: z.number().int().positive().optional(),
  response: z.number().int().positive().max(120_000).optional(),
  idle: z.number().int().positive().optional(),
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
  maxDelay: z.number().int().positive().max(60_000).optional(),
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
  ca: z.string().min(1).optional(),
  cert: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  passphrase: z.string().optional(),
}).strict().superRefine((ssl, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  const hasIdentity = ssl.cert !== undefined && ssl.key !== undefined;
  if (ssl.ca === undefined && ssl.cert === undefined && ssl.key === undefined) {
    issue('ca', 'ssl needs `ca` (server trust) or `cert`+`key` (client identity)');
  }
  if ((ssl.cert === undefined) !== (ssl.key === undefined)) {
    issue(ssl.cert === undefined ? 'cert' : 'key', 'cert and key go together (mTLS)');
  }
  if (ssl.passphrase !== undefined && ssl.key === undefined) issue('passphrase', 'passphrase requires key');
  const certMessage = 'expected PEM (-----BEGIN CERTIFICATE-----) or base64-encoded DER (.cer)';
  for (const field of ['ca', 'cert'] as const) {
    const value = ssl[field];
    if (value !== undefined && !isEnvRef(value) && !isCertificateMaterial(value)) issue(field, certMessage);
  }
  if (hasIdentity && ssl.key !== undefined && !isEnvRef(ssl.key) && !isPrivateKeyPem(ssl.key)) {
    issue('key', 'expected PEM private key (PKCS#8/PKCS#1/EC); convert with `openssl pkcs8 -topk8 -nocrypt -in key.der -inform DER`');
  }
});

export const BasicAuthSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
}).strict();

export const OAuth2ConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  accessTokenUri: z.string().min(1),
  scope: z.string().optional(),
}).strict();

export const JwtExternalConfigSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  credentialPlacement: z.enum(['header', 'body']).optional(),
  accessTokenUri: z.string().min(1),
  contentType: z.string().optional(),
  requestBody: z.record(z.unknown()).optional(),
  disableSSL: z.boolean().optional(),
  responsePath: z.string().optional(),
  requestHeader: z.string().optional(),
  tokenPrefix: z.string().optional(),
}).strict();

export const JwtLocalConfigSchema = z.object({
  algorithm: z.enum(['HS256', 'HS384', 'HS512', 'RS256']),
  secretOrPrivateKey: z.string().min(1),
  requestHeader: z.string().optional(),
  tokenPrefix: z.string().optional(),
}).strict();

export const AuthConfigSchema = z.object({
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
);
