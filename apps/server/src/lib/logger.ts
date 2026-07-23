import pino from 'pino';
import { trace } from '@opentelemetry/api';

export function createLogger(name: string, level?: string) {
  return pino({
    name,
    level: level || process.env.LOG_LEVEL || 'info',
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const ctx = span.spanContext();
      return {
        trace_id: ctx.traceId,
        span_id: ctx.spanId,
      };
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
