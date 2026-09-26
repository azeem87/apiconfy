import { describe } from 'bun:test';
import { runAdapterParity } from './parity-suite.js';
import { createCouchbaseAdapter } from '@/core/db/adapters/couchbase-adapter.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const isCouchbase = databaseUrl.startsWith('couchbase');

describe.skipIf(!isCouchbase)('Couchbase adapter (parity)', () => {
  runAdapterParity('couchbase', () => createCouchbaseAdapter(databaseUrl), {
    transactions: false,
    auditTrail: false,
  });
});
