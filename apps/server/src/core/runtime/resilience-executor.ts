import type { ResilienceConfig, TimeoutConfig } from '@/core/types.js';
import { AppError, ConnectionError, TimeoutError } from '@/lib/errors.js';

export interface ResiliencePolicy {
  timeout?: TimeoutConfig;
  resilience?: ResilienceConfig;
}

export interface ResilienceResult<T> {
  value: T;
  attempts: number;
}

export interface ResilienceExecutor {
  execute<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    policy: ResiliencePolicy
  ): Promise<ResilienceResult<T>>;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 30_000;
export const DEFAULT_RETRY_ON = [500, 502, 503];

function isRetryable(error: unknown, retryOn: number[]): boolean {
  if (error instanceof TimeoutError || error instanceof ConnectionError) return true;
  if (!(error instanceof AppError) || error.code !== 'EXTERNAL_ERROR') return false;
  const status = (error.details as { downstream?: { status?: number } } | undefined)?.downstream?.status;
  return typeof status === 'number' && status >= 500 && status <= 599 && retryOn.includes(status);
}

function delayFor(attempt: number, policy: ResilienceConfig): number {
  const base = policy.retryDelay ?? DEFAULT_RETRY_DELAY_MS;
  const multiplier = policy.backoff === 'exponential' ? 2 ** (attempt - 1) : 1;
  return Math.min(base * multiplier, policy.maxDelay ?? DEFAULT_MAX_DELAY_MS);
}

export class DefaultResilienceExecutor implements ResilienceExecutor {
  constructor(
    private readonly sleep: (ms: number) => Promise<void> =
      ms => new Promise(resolve => setTimeout(resolve, ms))
  ) {}

  async execute<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    policy: ResiliencePolicy
  ): Promise<ResilienceResult<T>> {
    const resilience = policy.resilience ?? {};
    for (let attempt = 1; ; attempt += 1) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError());
          controller.abort();
        }, policy.timeout?.response ?? DEFAULT_TIMEOUT_MS);
      });

      try {
        // The deadline includes the body read and bounds handlers which ignore cancellation.
        const value = await Promise.race([operation(controller.signal), deadline]);
        return { value, attempts: attempt };
      } catch (error) {
        if (
          attempt > (resilience.retryCount ?? 0)
          || !isRetryable(error, resilience.retryOn ?? DEFAULT_RETRY_ON)
        ) throw error;
      } finally {
        clearTimeout(timer);
      }
      await this.sleep(delayFor(attempt, resilience));
    }
  }
}
