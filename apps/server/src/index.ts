import { createApp } from '@/app.js';
import { loadConfig } from '@/config.js';
import { createDBAdapter } from '@/core/db/connection.js';
import { createLogger } from '@/lib/index.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger('server', config.logLevel);

  logger.info({ port: config.port }, 'Starting server');

  const db = await createDBAdapter();
  await db.connect();
  logger.info({ dbType: db.type }, 'Database connected');

  const { app } = createApp(config, db);

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

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });

  logger.info({ port: server.port }, 'Server ready');
}

main();
