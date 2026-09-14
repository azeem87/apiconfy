import type {
  ComponentLookup, ExecutionContext, ExecutionRecorder, InvocationRecord, InvokeParams,
} from './types.js';
import type { ComponentHandlerRegistry } from './component-handler-registry.js';
import type { ResilienceExecutor } from './resilience-executor.js';
import type { RateLimiter } from './rate-limiter.js';
import type { ComponentRequestSummary } from '@/core/components/base.js';
import { buildStandardError, injectStandardError, runResponsePipeline, transformResponse } from './response-pipeline.js';
import { evaluatePredicate } from '@/core/transform/index.js';
import { resolveEnvRefsDetailed } from '@/core/env-ref/index.js';
import type { InvocationResult, ResilienceConfig, TimeoutConfig } from '@/core/types.js';
import {
  AppError, NotFoundError, RateLimitError, TransformationError, UnknownComponentTypeError,
  collectSensitiveValues, redactSensitiveFields, scrubSecretValues, type Logger,
} from '@/lib/index.js';

export interface RuntimeExecutor {
  invoke(params: InvokeParams): Promise<InvocationResult>;
}

export interface DefaultRuntimeExecutorOptions {
  lookup: ComponentLookup;
  handlers: ComponentHandlerRegistry;
  resilience: ResilienceExecutor;
  rateLimiter: RateLimiter;
  recorder: ExecutionRecorder;
  logger: Logger;
  env?: Record<string, string | undefined>;
}

export class DefaultRuntimeExecutor implements RuntimeExecutor {
  constructor(private readonly options: DefaultRuntimeExecutorOptions) {}

  async invoke(params: InvokeParams): Promise<InvocationResult> {
    const { service, action, context, executionId, startedAtMs } = params;
    const record = await this.options.lookup.findByKey(service, action);
    if (!record) throw new NotFoundError(`Service not found: ${service}/${action}`);
    const bag: ExecutionContext = { context: { ...context, output: {} }, response: null };
    let config = record.config;
    let attempts = 0;
    const secrets = collectSensitiveValues(context);
    let request: ComponentRequestSummary | undefined;
    let rawResponse: unknown;
    let pipelineStarted = false;
    const scrub = <T>(value: T): T => scrubSecretValues(value, secrets);
    const finish = async (
      status: InvocationRecord['logStatus'], result: unknown, error?: AppError
    ): Promise<number> => {
      const completedAtMs = Date.now();
      const durationMs = completedAtMs - startedAtMs;
      await this.record({
        executionId, service, action, componentType: record.componentType,
        status: status === 'failed' ? 'FAILED' : 'COMPLETED', logStatus: status,
        context: scrub(redactSensitiveFields(context)), result, attempts, durationMs,
        startedAt: new Date(startedAtMs).toISOString(), completedAt: new Date(completedAtMs).toISOString(),
        request: request ? {
          uri: scrub(request.uri), method: request.method, body: scrub(redactSensitiveFields(request.body)),
        } : undefined,
        response: scrub(redactSensitiveFields(rawResponse)),
        error: error ? { code: error.code, message: error.message, details: error.details } : undefined,
      });
      return durationMs;
    };

    try {
      if (record.condition) {
        let shouldRun: boolean;
        try {
          shouldRun = evaluatePredicate(record.condition, bag);
        } catch {
          throw new TransformationError('Stored condition is malformed');
        }
        if (!shouldRun) {
          const durationMs = await finish('skipped', null);
          this.options.logger.info({ executionId }, 'Execution skipped');
          return { success: true, data: null, skippedExecution: true, meta: { executionId, durationMs } };
        }
      }
      const handler = this.options.handlers.get(record.componentType);
      if (!handler) throw new UnknownComponentTypeError(record.componentType, this.options.handlers.registeredTypes());
      handler.assertExecutable?.(record.config);
      secrets.push(...collectSensitiveValues(record.config));
      const resolved = resolveEnvRefsDetailed(record.config, this.options.env, secret => { secrets.push(secret); });
      config = resolved.config;
      const resilience = config.resilience as ResilienceConfig | undefined;
      if (resilience?.rateLimit) {
        const budget = await this.options.rateLimiter.consume(`${service}:${action}`, resilience.rateLimit);
        if (!budget.allowed) {
          throw new RateLimitError(`Rate limit exceeded for ${service}/${action}`, {
            limit: budget.limit, remaining: budget.remaining, resetTimeMs: budget.resetTimeMs,
            retryAfterSeconds: Math.max(1, Math.ceil((budget.resetTimeMs - Date.now()) / 1000)),
          });
        }
      }
      const outcome = await this.options.resilience.execute(signal => {
        attempts += 1;
        this.options.logger.debug({ executionId, attempt: attempts }, 'Component attempt');
        return handler.execute({
          config, context: bag, signal, executionId,
          onRequest: summary => { request = summary; },
        });
      }, { timeout: config.timeout as TimeoutConfig | undefined, resilience });
      request = outcome.value.request ?? request;
      rawResponse = outcome.value.data;
      secrets.push(...collectSensitiveValues(rawResponse));
      bag.response = outcome.value.data;
      pipelineStarted = true;
      const output = scrub(redactSensitiveFields(runResponsePipeline(config, bag)));
      const durationMs = await finish('success', output);
      return { success: true, data: output, meta: { executionId, durationMs } };
    } catch (caught) {
      const error = caught instanceof AppError ? caught : new AppError('Internal server error', 'INTERNAL_ERROR');
      const downstream = (error.details as { downstream?: { body?: unknown } } | undefined)?.downstream;
      if (downstream && Object.hasOwn(downstream, 'body')) {
        bag.response = downstream.body;
        rawResponse = downstream.body;
        secrets.push(...collectSensitiveValues(rawResponse));
      }
      let output: unknown;
      try {
        output = pipelineStarted ? transformResponse(config, bag) : runResponsePipeline(config, bag);
      } catch {
        // A failed rule prevents defaults, not mapping. Preserve the primary error if mapping fails.
        try {
          output = transformResponse(config, bag);
        } catch {
          this.options.logger.warn({ executionId }, 'Failure response transformation failed');
          output = null;
        }
      }
      const standard = buildStandardError(error).error;
      output = injectStandardError(scrub(redactSensitiveFields(output)), { error: {
        code: standard.code,
        message: scrub(standard.message),
        ...(standard.details ? { details: standard.details.map(detail => ({
          rule: scrub(detail.rule), message: scrub(detail.message), path: scrub(detail.path),
        })) } : {}),
        ...(standard.downstream ? { downstream: {
          status: standard.downstream.status, body: scrub(redactSensitiveFields(standard.downstream.body)),
        } } : {}),
      } });
      const safeError = new AppError(
        scrub(error.message), error.code, error.statusCode, sanitizeErrorDetails(error, secrets)
      );
      await finish('failed', output, safeError);
      this.options.logger.warn({ executionId, code: safeError.code }, 'Service invocation failed');
      throw safeError;
    }

    function sanitizeErrorDetails(error: AppError, secrets: string[]): AppError['details'] {
      const details = error.details;
      if (details === undefined) return undefined;
      // These are runtime-generated control metadata, not payloads. Their names and numbers
      // must remain usable even when a short credential happens to match part of them.
      if (['RATE_LIMITED', 'NOT_IMPLEMENTED', 'UNKNOWN_COMPONENT_TYPE', 'ENV_REF_UNRESOLVED'].includes(error.code)) {
        return details;
      }
      if (error.code === 'EXTERNAL_ERROR') {
        const downstream = (details as { downstream?: { status?: number; body?: unknown } }).downstream;
        if (downstream) return { downstream: {
          status: downstream.status, body: scrubSecretValues(redactSensitiveFields(downstream.body), secrets),
        } };
      }
      if (error.code === 'VALIDATION_FAILED' && !Array.isArray(details)) {
        return Object.fromEntries(Object.entries(details).map(
          ([key, value]) => [key, scrubSecretValues(redactSensitiveFields(value), secrets)]
        ));
      }
      return scrubSecretValues(redactSensitiveFields(details), secrets);
    }
  }

  private async record(entry: InvocationRecord): Promise<void> {
    try {
      await this.options.recorder.recordInvocation(entry);
    } catch {
      this.options.logger.warn({ executionId: entry.executionId }, 'Failed to persist execution record');
    }
  }
}
