import { z } from 'zod';
import { assertValidExpression, assertValidPath } from '@/core/transform/index.js';

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

export const RateLimitConfigSchema = z.object({
  requests: z.number().int().positive(),
  windowMs: z.number().int().positive(),
}).strict();

export const ResilienceConfigSchema = z.object({
  retryCount: z.number().int().min(0).max(10).optional(),
  retryDelay: z.number().int().positive().optional(),
  backoff: z.enum(['fixed', 'exponential']).optional(),
  maxDelay: z.number().int().positive().max(60_000).optional(),
  retryOn: z.array(z.number().int()).optional(),
  rateLimit: RateLimitConfigSchema.optional(),
  circuitBreaker: CircuitBreakerConfigSchema.optional(),
}).strict();

export const ValidationRuleSchema = z.object({
  expression: z.string().min(1),
  message: z.string().optional(),
  errorPath: z.string().optional(),
}).strict();

export const ResponseConfigSchema = z.object({
  transformation: z.record(z.unknown()).optional(),
  validation: z.object({
    rules: z.array(ValidationRuleSchema).optional(),
  }).strict().optional(),
  default: z.record(z.unknown()).optional(),
}).strict().superRefine((config, ctx) => {
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

export const SSLConfigSchema = z.object({
  cert: z.string().min(1),
  key: z.string().min(1),
  ca: z.string().optional(),
  passphrase: z.string().optional(),
}).strict();

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
