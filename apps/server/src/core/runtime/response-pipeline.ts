import {
  evaluatePredicate, firstPathOperand, resolveTemplate,
} from '@/core/transform/index.js';
import type { ResponseConfig, StandardError } from '@/core/types.js';
import type { ExecutionContext } from './types.js';
import {
  type AppError, ExternalServiceError, ResponseValidationError, TransformationError,
} from '@/lib/errors.js';

export function transformResponse(config: Record<string, unknown>, bag: ExecutionContext): unknown {
  const response = config.response as ResponseConfig | undefined;
  if (response?.transformation === undefined) return bag.response;
  try {
    return resolveTemplate(response.transformation, bag);
  } catch {
    throw new TransformationError('Response transformation failed');
  }
}

/** Validation controls default eligibility, never whether failure output can be mapped. */
export function runResponsePipeline(config: Record<string, unknown>, bag: ExecutionContext): unknown {
  const response = config.response as ResponseConfig | undefined;
  for (const rule of response?.validation?.rules ?? []) {
    let passed: boolean;
    try {
      passed = evaluatePredicate(rule.expression, bag);
    } catch {
      throw new TransformationError('Stored validation expression is malformed');
    }
    if (passed) continue;
    const extracted = rule.errorPath ? resolveTemplate(rule.errorPath, bag) : null;
    const message = typeof extracted === 'number' || typeof extracted === 'boolean'
      ? String(extracted)
      : typeof extracted === 'string' && extracted !== rule.errorPath && extracted.length > 0
        ? extracted
        : rule.message ?? `Validation rule failed: ${rule.expression}`;
    throw new ResponseValidationError(message, {
      expression: rule.expression,
      errorPath: rule.errorPath,
      path: firstPathOperand(rule.expression) ?? rule.expression,
    });
  }
  const empty = bag.response === null || bag.response === undefined || bag.response === '';
  if (empty && response?.default !== undefined) bag.response = response.default;
  return transformResponse(config, bag);
}

export function buildStandardError(error: AppError): StandardError {
  const details = error instanceof ResponseValidationError
    ? [{ rule: error.failure.expression, message: error.message, path: error.failure.path }]
    : undefined;
  const downstream = error instanceof ExternalServiceError
    ? (error.details as { downstream?: StandardError['error']['downstream'] } | undefined)?.downstream
    : undefined;
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(details ? { details } : {}),
      ...(downstream ? { downstream } : {}),
    },
  };
}

export function injectStandardError(output: unknown, standardError: StandardError): unknown {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return { ...standardError };
  const record = output as Record<string, unknown>;
  const keys = Object.keys(record);
  const key = keys[0];
  const value = record[key];
  if (keys.length === 1 && key !== 'error' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ...record, [key]: { ...value, ...standardError } };
  }
  return { ...record, ...standardError };
}
