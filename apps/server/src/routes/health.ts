import { Hono } from 'hono';
import type { DBAdapter } from '@/core/db/adapter.js';

export function healthRoute(db?: DBAdapter) {
  const router = new Hono();

  router.get('/health', async (c) => {
    let dbStatus = 'unknown';
    if (db) {
      try {
        const dbType = db.type;
        dbStatus = `connected (${dbType})`;
      } catch {
        dbStatus = 'disconnected';
      }
    } else {
      dbStatus = 'not configured';
    }

    return c.json({
      status: 'ok',
      version: '0.1.0',
      db: dbStatus,
    });
  });

  return router;
}
