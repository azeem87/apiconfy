import type { DBAdapter } from './adapter.js';
import { DatabaseError } from '@/lib/errors.js';
import { createSqliteAdapter } from './adapters/sqlite-adapter.js';
import { createPostgresAdapter } from './adapters/postgres-adapter.js';
import { createMariaDbAdapter } from './adapters/mariadb-adapter.js';
import { createOracleAdapter } from './adapters/oracle-adapter.js';
import { createMongoDbAdapter } from './adapters/mongodb-adapter.js';
import { createCouchbaseAdapter } from './adapters/couchbase-adapter.js';

export type { DBAdapter };

const DEFAULT_SQLITE_PATH = '../../data/apiconfy.db';

const SUPPORTED_SCHEMES = [
  'sqlite:<path>',
  'postgres://',
  'mysql://',
  'mariadb://',
  'oracle://',
  'mongodb://',
  'couchbase:// (+ CB_BUCKET)',
];

/** Path precedence: the `sqlite:` URL's own path → SQLITE_PATH → the default file. */
export function resolveSqlitePath(databaseUrl = ''): string {
  if (databaseUrl.startsWith('sqlite:')) {
    const inline = databaseUrl.slice('sqlite:'.length).replace(/^\/\//, '');
    if (inline !== '') return inline;
  }
  return process.env.SQLITE_PATH || DEFAULT_SQLITE_PATH;
}

/**
 * The engine comes from `DATABASE_URL` alone. Unset or empty selects SQLite
 * (local development, logged as a warning by the caller); anything else is used
 * exactly as configured — a named engine is never replaced by SQLite, and an
 * unknown scheme refuses to start.
 */
export async function createDBAdapter(): Promise<DBAdapter> {
  const databaseUrl = (process.env.DATABASE_URL ?? '').trim();

  if (databaseUrl === '') {
    return createSqliteAdapter(resolveSqlitePath());
  }
  if (databaseUrl.startsWith('sqlite:')) {
    return createSqliteAdapter(resolveSqlitePath(databaseUrl));
  }
  if (databaseUrl.startsWith('postgres')) {
    return createPostgresAdapter(databaseUrl);
  }
  if (databaseUrl.startsWith('mysql://') || databaseUrl.startsWith('mariadb://')) {
    return createMariaDbAdapter(databaseUrl);
  }
  if (databaseUrl.startsWith('oracle://')) {
    return createOracleAdapter(databaseUrl);
  }
  if (databaseUrl.startsWith('mongodb://')) {
    return createMongoDbAdapter(databaseUrl);
  }
  if (databaseUrl.startsWith('couchbase://')) {
    return createCouchbaseAdapter(databaseUrl);
  }

  throw new DatabaseError(
    `Unsupported DATABASE_URL — no engine matches "${databaseUrl.split(':')[0]}". `
    + `Supported: ${SUPPORTED_SCHEMES.join(', ')}. `
    + 'A named engine is never replaced by SQLite; fix the URL or leave it unset for local SQLite.'
  );
}

export function createDBAdapterForTest(dbPath?: string): DBAdapter {
  return createSqliteAdapter(dbPath ?? ':memory:');
}
