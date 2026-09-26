import { describe } from 'bun:test';
import { runAdapterParity } from './parity-suite.js';
import { createPostgresAdapter } from '@/core/db/adapters/postgres-adapter.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const isPostgres = databaseUrl.startsWith('postgres');

describe.skipIf(!isPostgres)('PostgreSQL adapter (parity)', () => {
  runAdapterParity('postgres', () => createPostgresAdapter(databaseUrl));
});
