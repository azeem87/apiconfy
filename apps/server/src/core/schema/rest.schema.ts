import { z } from 'zod';
import {
  AuthConfigSchema,
  ResilienceConfigSchema,
  ResponseConfigSchema,
  SSLConfigSchema,
  TimeoutConfigSchema,
} from './common.schema.js';

export const RestConfigSchema = z.object({
  uri: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  contentType: z.string().optional(),
  disableSSL: z.boolean().optional(),
  ssl: SSLConfigSchema.optional(),
  timeout: TimeoutConfigSchema.optional(),
  resilience: ResilienceConfigSchema.optional(),
  headers: z.record(z.string()).optional(),
  payloadTemplate: z.record(z.unknown()).optional(),
  auth: AuthConfigSchema.optional(),
  response: ResponseConfigSchema.optional(),
}).strict().refine(
  (config) => !(config.ssl && config.disableSSL),
  { message: 'ssl and disableSSL are mutually exclusive', path: ['ssl'] }
);

export type RestConfigInput = z.input<typeof RestConfigSchema>;
