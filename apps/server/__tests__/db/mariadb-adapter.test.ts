import { describe } from 'bun:test';
import { runAdapterParity } from './parity-suite.js';
import { createMariaDbAdapter } from '@/core/db/adapters/mariadb-adapter.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const isMariaDb = databaseUrl.startsWith('mysql') || databaseUrl.startsWith('mariadb');

describe.skipIf(!isMariaDb)('MariaDB adapter (parity)', () => {
  runAdapterParity('mariadb', () => createMariaDbAdapter(databaseUrl), { auditTrail: false });
});
