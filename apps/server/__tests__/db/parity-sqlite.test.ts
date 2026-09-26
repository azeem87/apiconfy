import { describe } from 'bun:test';
import { runAdapterParity } from './parity-suite.js';
import { createSqliteAdapter } from '@/core/db/adapters/sqlite-adapter.js';

describe('SQLite adapter (parity)', () => {
  runAdapterParity('sqlite', async () => createSqliteAdapter(':memory:'));
});
