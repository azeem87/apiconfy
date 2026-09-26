import { describe } from 'bun:test';
import { runAdapterParity } from './parity-suite.js';
import { createMongoDbAdapter } from '@/core/db/adapters/mongodb-adapter.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const isMongo = databaseUrl.startsWith('mongodb');

describe.skipIf(!isMongo)('MongoDB adapter (parity)', () => {
  runAdapterParity('mongodb', () => createMongoDbAdapter(databaseUrl));
});
