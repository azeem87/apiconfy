import type { DBAdapter } from './adapter.js';
import { createSqliteAdapter } from './adapters/sqlite-adapter.js';
import { createPostgresAdapter } from './adapters/postgres-adapter.js';

export type { DBAdapter };

export async function createDBAdapter(): Promise<DBAdapter> {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl?.startsWith('postgres')) {
    return createPostgresAdapter(databaseUrl);
  }

  const sqlitePath = process.env.SQLITE_PATH || '../../data/apiconfy.db';
  return createSqliteAdapter(sqlitePath);
}

export function createDBAdapterForTest(dbPath?: string): DBAdapter {
  return createSqliteAdapter(dbPath ?? ':memory:');
}
