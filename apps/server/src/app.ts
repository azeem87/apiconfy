import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context, Next } from 'hono';
import { createLogger, type Logger } from '@/lib/index.js';
import { healthRoute } from '@/routes/health.js';
import { servicesRoute } from '@/routes/services.route.js';
import { invokeRoute } from '@/routes/invoke.route.js';
import { executionsRoute } from '@/routes/executions.route.js';
import { authMiddleware } from '@/middleware/auth.js';
import { errorHandler } from '@/middleware/error.js';
import { requestLogger } from '@/middleware/logger.js';
import { createCoreSchemaRegistry, type SchemaRegistry } from '@/core/schema/index.js';
import { createCoreHandlerRegistry } from '@/core/components/index.js';
import {
  type ComponentHandlerRegistry, DefaultResilienceExecutor,
  DefaultRuntimeExecutor, InMemoryTokenBucketRateLimiter,
} from '@/core/runtime/index.js';
import { DbComponentRepository } from '@/core/db/repositories/component.repository.js';
import { DbExecutionRepository } from '@/core/db/repositories/execution.repository.js';
import { ComponentRegistryService } from '@/services/component-registry.service.js';
import type { AppConfig } from '@/config.js';
import type { DBAdapter } from '@/core/db/adapter.js';

export interface AppDependencies {
  schemas?: SchemaRegistry;
  handlers?: ComponentHandlerRegistry;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** Registration/invocation bodies have no legitimate reason to exceed this. */
const MAX_REQUEST_BODY_BYTES = 1_000_000;

/** Reject non-JSON bodies on methods that carry a payload. */
async function requireJsonContentType(c: Context, next: Next) {
  if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
    const contentType = c.req.header('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
      return c.json({
        success: false,
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' },
      }, 415);
    }
  }
  return next();
}

export function createApp(config: AppConfig, db: DBAdapter, deps: AppDependencies = {}): { app: Hono; logger: Logger } {
  const logger = createLogger('server', config.logLevel);
  const app = new Hono();

  app.use('*', requestLogger(logger));
  app.use('/api/*', bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c) => c.json({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the maximum allowed size' },
    }, 413),
  }));
  app.use('/api/*', requireJsonContentType);
  app.use('/api/*', authMiddleware(config.apiKey));
  app.onError(errorHandler(logger));

  app.route('/', healthRoute(db));

  const components = new DbComponentRepository(db);
  const executions = new DbExecutionRepository(db);
  const executor = new DefaultRuntimeExecutor({
    lookup: components,
    handlers: deps.handlers ?? createCoreHandlerRegistry(deps.fetch),
    resilience: new DefaultResilienceExecutor(),
    rateLimiter: new InMemoryTokenBucketRateLimiter(),
    recorder: executions,
    logger,
    env: deps.env,
  });
  app.route('/api', servicesRoute(new ComponentRegistryService(
    components, deps.schemas ?? createCoreSchemaRegistry()
  )));
  app.route('/api', invokeRoute(executor));
  app.route('/api', executionsRoute(executions));

  return { app, logger };
}

export type { Logger };
