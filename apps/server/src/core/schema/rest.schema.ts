import { z } from 'zod';
import {
  AuthConfigSchema,
  ResilienceConfigSchema,
  ResponseConfigSchema,
  SSLConfigSchema,
  TimeoutConfigSchema,
} from './common.schema.js';

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
  response: ResponseConfigSchema.optional(),
}).strict();

export type RestConfigInput = z.input<typeof RestConfigSchema>;
