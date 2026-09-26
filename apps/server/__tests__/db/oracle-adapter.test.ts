import { describe } from 'bun:test';
import { runAdapterParity } from './parity-suite.js';
import { createOracleAdapter } from '@/core/db/adapters/oracle-adapter.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const isOracle = databaseUrl.startsWith('oracle');

describe.skipIf(!isOracle)('Oracle adapter (parity)', () => {
  runAdapterParity('oracle', () => createOracleAdapter(databaseUrl));
});
