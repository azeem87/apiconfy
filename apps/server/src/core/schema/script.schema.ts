import { z } from 'zod';
import { assertValidScriptExpression } from '@/core/transform/script-expression.js';

/** Deadline override only — connect/socket/idle describe transports a script does not have (§D6). */
const ScriptTimeoutSchema = z.object({
  response: z.number().int().positive().max(120_000).optional(),
}).strict();

/**
 * Phase 3.5 — a local context transformer (plans/script-component.md).
 * `.strict()` is what refuses `uri`, `method`, `headers`, `auth`, `ssl`, `payloadTemplate`,
 * `resilience`, `output` and `timeout.connect|socket|idle` with a clear `400` instead of
 * accepting them as silent no-ops.
 */
export const ScriptConfigSchema = z.object({
  expression: z.string().min(1),
  timeout: ScriptTimeoutSchema.optional(),
}).strict().superRefine((config, ctx) => {
  if (config.expression.includes('$env.')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expression'],
      message: '$env. references are not allowed in a script expression',
    });
    return;
  }
  try {
    assertValidScriptExpression(config.expression);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expression'],
      message: error instanceof Error ? error.message : 'Invalid expression',
    });
  }
});

export type ScriptConfigInput = z.input<typeof ScriptConfigSchema>;
