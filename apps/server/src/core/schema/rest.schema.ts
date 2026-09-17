import { z } from 'zod';
import {
  AuthConfigSchema,
  OutputConfigSchema,
  ResilienceConfigSchema,
  SSLConfigSchema,
  TimeoutConfigSchema,
} from './common.schema.js';
import { collectTemplateIssues } from '@/core/transform/template-validation.js';

const RequestConfigSchema = z.object({
  uri: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  contentType: z.string().optional(),
  headers: z.record(z.string()).optional(),
  payloadTemplate: z.record(z.unknown()).optional(),
  auth: AuthConfigSchema.optional(),
  ssl: SSLConfigSchema.optional(),
  disableSSL: z.boolean().optional(),
}).strict().refine(
  (config) => !(config.ssl && config.disableSSL),
  { message: 'ssl and disableSSL are mutually exclusive', path: ['ssl'] }
);

export const RestConfigSchema = z.object({
  request: RequestConfigSchema,
  timeout: TimeoutConfigSchema.optional(),
  resilience: ResilienceConfigSchema.optional(),
  output: OutputConfigSchema.optional(),
}).strict().superRefine((config, ctx) => {
  // Template fields only: `auth`/`ssl` carry credentials and PEM material, which the runtime never
  // template-resolves, so a literal `{$` there must not be treated as an expression.
  const templateFields: Array<[string[], unknown]> = [
    [['request', 'uri'], config.request.uri],
    [['request', 'contentType'], config.request.contentType],
    [['request', 'headers'], config.request.headers],
    [['request', 'payloadTemplate'], config.request.payloadTemplate],
  ];
  for (const [path, value] of templateFields) {
    for (const issue of collectTemplateIssues(value, path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.path,
        message: `${issue.message} (at "${issue.value}")`,
      });
    }
  }
});

export type RestConfigInput = z.input<typeof RestConfigSchema>;
