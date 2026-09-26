// ============================================================================
// Apiconfy — MongoDB schema (collections + indexes)
//
// Run this ONCE with an account that can create collections and indexes:
//   mongosh "<DATABASE_URL>" apps/server/src/core/db/schema/mongodb/mongodb.js
//
// The application never creates collections or indexes — on startup it probes
// for the collections and for the unique indexes below, and exits with this
// file's path when anything is missing.
//
// Field names are the app's camelCase record fields. The unique indexes are
// load-bearing: without them the adapter cannot raise ConflictError on a
// duplicate, because MongoDB has no constraint the KV-style writes could hit.
//
// Collections: component_definitions, workflow_definitions, workflow_steps,
//              executions, master_configuration   (all required)
//              execution_logs                     (optional — see the end of file)
// ============================================================================

const required = [
  'component_definitions',
  'workflow_definitions',
  'workflow_steps',
  'executions',
  'master_configuration',
];

// OPTIONAL: add 'execution_logs' to this list ONLY when ENABLE_DB_TRANSACTION_LOGS=true
const existing = db.getCollectionNames();
for (const name of required) {
  if (!existing.includes(name)) {
    db.createCollection(name);
    print(`created collection ${name}`);
  }
}

// ---- Unique indexes (the ConflictError path) -------------------------------
db.component_definitions.createIndex(
  { service: 1, action: 1 },
  { unique: true, name: 'uniq_component_natural_key' }
);
db.workflow_definitions.createIndex({ name: 1 }, { unique: true, name: 'uniq_workflow_name' });
db.master_configuration.createIndex({ key: 1 }, { unique: true, name: 'uniq_config_key' });

// ---- Lookup and ordering indexes -------------------------------------------
db.component_definitions.createIndex({ id: 1 }, { name: 'ix_component_id' });
db.component_definitions.createIndex({ createdAt: 1, id: 1 }, { name: 'ix_component_order' });
db.workflow_definitions.createIndex({ id: 1 }, { name: 'ix_workflow_id' });
db.workflow_definitions.createIndex({ createdAt: 1, id: 1 }, { name: 'ix_workflow_order' });
db.workflow_steps.createIndex({ workflowId: 1, stepOrder: 1 }, { name: 'ix_steps_workflow' });
db.workflow_steps.createIndex({ componentId: 1 }, { name: 'ix_steps_component' });
db.executions.createIndex({ executionId: 1 }, { name: 'ix_execution_id' });

// ============================================================================
// OPTIONAL — execution_logs
//
// Uncomment these two lines (and add 'execution_logs' to `required` above)
// ONLY when ENABLE_DB_TRANSACTION_LOGS=true. The startup probe demands the
// collection whenever that flag is on, so leaving it uncreated while the flag
// is set means the app will not start.
// ============================================================================
// db.createCollection('execution_logs');
// db.execution_logs.createIndex({ executionId: 1, createdAt: 1 }, { name: 'ix_logs_execution' });

print('MongoDB schema ready');
