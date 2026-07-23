import type { DBAdapter } from '../adapter.js';

export async function createPostgresAdapter(databaseUrl: string): Promise<DBAdapter> {
  throw new Error('Postgres adapter not yet implemented');
}
