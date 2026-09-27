import { createApp } from '@/app.js';
import { authPostureProblem, loadConfig } from '@/config.js';
import { createDBAdapter, type DBAdapter } from '@/core/db/connection.js';
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
  let db: DBAdapter;
  try {
    db = await createDBAdapter();
    await db.connect();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (db.type === 'sqlite') {
    logger.warn(
      'SQLite selected — a single local file with no durability guarantees; local development only. '
      + 'Set DATABASE_URL for a server engine (or a replicated SQLite such as Turso/LiteFS) in production.'
    );
  }
  const dbTime = performance.now() - dbStartTime;
  logger.info({ dbType: db.type, connectTimeMs: Math.round(dbTime) }, 'Database connected');

  const appStartTime = performance.now();
  const { app, drainExecutionQueue } = createApp(config, db);
  const appTime = performance.now() - appStartTime;

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

  // OpenShift/Kubernetes send SIGTERM, then SIGKILL once terminationGracePeriodSeconds
  // (default 30s) elapses. Stop accepting connections first so nothing enqueues mid-drain,
  // let in-flight requests finish, then flush queued execution records and close the DB.
  // Keep the grace period above STOP_WAIT_MS + DRAIN_TIMEOUT_MS.
  const STOP_WAIT_MS = 5_000;
  const DRAIN_TIMEOUT_MS = 10_000;
  let shuttingDown = false;

  async function shutdown(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    try {
      await Promise.race([server.stop(), Bun.sleep(STOP_WAIT_MS)]);
      if (server.pendingRequests > 0) {
        logger.warn(
          { pendingRequests: server.pendingRequests },
          'In-flight requests did not finish in time; closing connections',
        );
        await server.stop(true);
      }
      await drainExecutionQueue(DRAIN_TIMEOUT_MS);
      await db.disconnect();
    } catch (err) {
      // Exit 0 regardless: a failed shutdown during a rollout must not look like a crash.
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Error during shutdown',
      );
    } finally {
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((err) => {
  process.stderr.write(`Fatal startup error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
