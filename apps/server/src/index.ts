import { createApp } from '@/app.js';
import { authPostureProblem, loadConfig } from '@/config.js';
import { createDBAdapter } from '@/core/db/connection.js';
import { createLogger } from '@/lib/index.js';

async function main() {
  const startTime = performance.now();
  const config = loadConfig();
  const logger = createLogger('server', config.logLevel);

  const postureProblem = authPostureProblem(config);
  if (postureProblem) {
    logger.error(postureProblem);
    process.exit(1);
  }

  if (!config.apiKey) {
    logger.warn('API_KEY is not set — all /api/* routes are open. Set API_KEY for production use.');
  }

  logger.info({ port: config.port }, 'Starting server');

  const dbStartTime = performance.now();
  const db = await createDBAdapter();
  await db.connect();
  const dbTime = performance.now() - dbStartTime;
  logger.info({ dbType: db.type, connectTimeMs: Math.round(dbTime) }, 'Database connected');

  const appStartTime = performance.now();
  const { app } = createApp(config, db);
  const appTime = performance.now() - appStartTime;

  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down');
    await db.disconnect();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down');
    await db.disconnect();
    process.exit(0);
  });

  const serverStartTime = performance.now();
  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });
  const serverTime = performance.now() - serverStartTime;

  const totalTime = performance.now() - startTime;
  logger.info(
    { 
      port: server.port, 
      startupTimeMs: Math.round(totalTime),
      breakdown: {
        dbConnectMs: Math.round(dbTime),
        appInitMs: Math.round(appTime),
        serverStartMs: Math.round(serverTime)
      }
    }, 
    `Server ready in ${Math.round(totalTime)}ms`
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal startup error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
