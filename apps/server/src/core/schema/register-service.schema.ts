import { z } from 'zod';
import { assertValidExpression } from '@/core/transform/index.js';

const urlSafeRegex = /^[a-zA-Z0-9_-]+$/;
const urlSafeMsg = 'must be URL-safe (letters, numbers, _, - only)';

function validateCondition<T extends { condition?: string }>(body: T, ctx: z.RefinementCtx) {
  if (!body.condition) return;
  try {
    assertValidExpression(body.condition);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['condition'],
      message: error instanceof Error ? error.message : 'Invalid expression',
    });
  }
}

/**
 * Create: service + action in body, no version.
 * `config` is deliberately `z.record(z.unknown())` — re-validated per componentType in stage 2.
 */
export const CreateServiceRequestSchema = z.object({
  service: z.string().min(1).regex(urlSafeRegex, urlSafeMsg),
  action: z.string().min(1).regex(urlSafeRegex, urlSafeMsg),
  componentType: z.string().min(1),
  description: z.string().optional(),
  config: z.record(z.unknown()),
  condition: z.string().min(1).optional(),
  metaData: z.record(z.unknown()).optional(),
}).strict().superRefine(validateCondition);

/**
 * Update: service + action come from URL path. Version is required for optimistic concurrency.
 * `config` is deliberately `z.record(z.unknown())` — re-validated per componentType in stage 2.
 */
export const UpdateServiceRequestSchema = z.object({
  componentType: z.string().min(1),
  description: z.string().optional(),
  config: z.record(z.unknown()),
  condition: z.string().min(1).optional(),
  metaData: z.record(z.unknown()).optional(),
  version: z.number().int().positive(),
}).strict().superRefine(validateCondition);

export type CreateServiceRequestInput = z.infer<typeof CreateServiceRequestSchema>;
export type UpdateServiceRequestInput = z.infer<typeof UpdateServiceRequestSchema>;
