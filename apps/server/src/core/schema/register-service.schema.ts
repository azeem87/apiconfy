import { z } from 'zod';
import { assertValidExpression } from '@/core/transform/index.js';

/**
 * Stage-1 envelope validation. `config` is deliberately `z.record(z.unknown())` here —
 * it is re-validated in stage 2 against the schema registered for `componentType`.
 */
export const RegisterServiceRequestSchema = z.object({
  service: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'must be URL-safe (letters, numbers, _, - only)'),
  action: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'must be URL-safe (letters, numbers, _, - only)'),
  componentType: z.string().min(1),
  description: z.string().optional(),
  config: z.record(z.unknown()),
  condition: z.string().min(1).optional(),
  metaData: z.record(z.unknown()).optional(),
}).strict().superRefine((body, ctx) => {
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
});

export type RegisterServiceRequestInput = z.infer<typeof RegisterServiceRequestSchema>;
