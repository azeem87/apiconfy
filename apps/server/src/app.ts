import { Hono } from 'hono';
import { createLogger, type Logger } from '@/lib/index.js';
import { healthRoute } from '@/routes/health.js';
import { authMiddleware } from '@/middleware/auth.js';
import { errorHandler } from '@/middleware/error.js';
import { requestLogger } from '@/middleware/logger.js';
import type { AppConfig } from '@/config.js';
import type { DBAdapter } from '@/core/db/adapter.js';

export function createApp(config: AppConfig, db?: DBAdapter): { app: Hono; logger: Logger } {
  const logger = createLogger('server', config.logLevel);
  const app = new Hono();

  app.use('*', requestLogger(logger));
  app.use('*', authMiddleware(config.apiKey));
  app.onError(errorHandler(logger));

  app.route('/', healthRoute(db));

  // Business routes all use /api prefix — see .commandcode/plans/api-routes.md
  // app.route('/api', componentsRoute());  // Phase 1
  // app.route('/api', invokeRoute());      // Phase 2
  // app.route('/api', workflowsRoute());   // Phase 5

  return { app, logger };
}

export type { Logger };
