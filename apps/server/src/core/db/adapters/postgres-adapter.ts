import type { DBAdapter } from '../adapter.js';

export async function createPostgresAdapter(_databaseUrl: string): Promise<DBAdapter> {
  throw new Error('Postgres adapter not yet implemented');
}
