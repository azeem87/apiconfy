/**
 * Apiconfy — Couchbase schema (bucket scope, collections, indexes)
 *
 * Run this ONCE with an account that can manage collections and indexes:
 *   CB_URL=couchbase://localhost CB_USER=Administrator CB_PASS=password CB_BUCKET=apiconfy \
 *     bun run apps/server/src/core/db/schema/couchbase/couchbase.js
 *
 * The application never creates schema — on startup it probes for the scope,
 * the collections below and each collection's primary index, and exits with
 * this file's path when anything is missing.
 *
 * Decision #6 lives here: components, workflows and config are keyed by their
 * natural key (`component::<service>::<action>`, `wf::<name>`, `cfg::<key>`),
 * so no unique index exists or is needed — the key is the constraint. The
 * secondary indexes below exist for the by-id and filtered reads the adapter
 * performs with N1QL.
 *
 * Collections: component_definitions, workflow_definitions, workflow_steps,
 *              executions, master_configuration   (all required)
 *              execution_logs                     (optional — see the end of file)
 */
import { connect } from 'couchbase';

const url = process.env.CB_URL ?? 'couchbase://localhost';
const username = process.env.CB_USER ?? 'Administrator';
const password = process.env.CB_PASS ?? 'password';
const bucketName = process.env.CB_BUCKET ?? 'apiconfy';
const scopeName = process.env.CB_SCOPE ?? '_default';

const collections = [
  'component_definitions',
  'workflow_definitions',
  'workflow_steps',
  'executions',
  'master_configuration',
];

const indexes = [
  { collection: 'component_definitions', name: 'ix_component_id', keys: 'id' },
  { collection: 'component_definitions', name: 'ix_component_service', keys: 'service' },
  { collection: 'component_definitions', name: 'ix_component_order', keys: 'createdAt, id' },
  { collection: 'workflow_definitions', name: 'ix_workflow_id', keys: 'id' },
  { collection: 'workflow_definitions', name: 'ix_workflow_name', keys: 'name' },
  { collection: 'workflow_definitions', name: 'ix_workflow_order', keys: 'createdAt, id' },
  { collection: 'workflow_steps', name: 'ix_steps_workflow', keys: 'workflowId, stepOrder' },
  { collection: 'workflow_steps', name: 'ix_steps_component', keys: 'componentId' },
  { collection: 'executions', name: 'ix_execution_id', keys: 'executionId' },
  // No index on master_configuration: the adapter reaches config only by KV (`cfg::<key>`),
  // and `key` is a reserved word in N1QL anyway.
];

const cluster = await connect(url, { username, password });
try {
  const bucket = cluster.bucket(bucketName);

  for (const name of collections) {
    try {
      await bucket.collections().createCollection({ name, scopeName });
      console.log(`created collection ${scopeName}.${name}`);
    } catch (err) {
      // 601 = collection_exists; the SDK message is "collection exists".
      const message = String(err?.message ?? err);
      if (err?.code === 601 || /exists/i.test(message)) continue;
      throw err;
    }
  }

  const ks = (collection) => `\`${bucketName}\`.\`${scopeName}\`.\`${collection}\``;

  // Couchbase has no `CREATE INDEX IF NOT EXISTS <name>` — that clause is only valid for
  // primary indexes — so a re-run is made idempotent by treating "already exists" as success.
  const ensureIndex = async (collection, name, keys) => {
    try {
      await cluster.query(`CREATE INDEX ${name} ON ${ks(collection)} (${keys})`);
      console.log(`ensured index ${name} on ${collection} (${keys})`);
    } catch (err) {
      // 18 = index_exists from the SDK; 4300 is the inner query error code.
      const message = String(err?.message ?? err);
      if (err?.code === 18 || err?.code === 4300 || /exists/i.test(message)) return;
      throw err;
    }
  };

  for (const { collection, name, keys } of indexes) {
    await ensureIndex(collection, name, keys);
  }

  for (const collection of collections) {
    await cluster.query(`CREATE PRIMARY INDEX IF NOT EXISTS ON ${ks(collection)}`);
    console.log(`ensured primary index on ${collection}`);
  }

  // ==========================================================================
  // OPTIONAL — execution_logs
  //
  // Uncomment these three statements (and add 'execution_logs' to `collections`
  // above) ONLY when ENABLE_DB_TRANSACTION_LOGS=true. The startup probe demands
  // the collection and its primary index whenever that flag is on, so leaving
  // them uncreated while the flag is set means the app will not start.
  // ==========================================================================
  // try { await bucket.collections().createCollection({ name: 'execution_logs', scopeName }); } catch (err) {}
  // await cluster.query(`CREATE INDEX IF NOT EXISTS ix_logs_execution ON ${ks('execution_logs')} (executionId, createdAt)`);
  // await cluster.query(`CREATE PRIMARY INDEX IF NOT EXISTS ON ${ks('execution_logs')}`);

  console.log('Couchbase schema ready');
} finally {
  await cluster.close();
}
