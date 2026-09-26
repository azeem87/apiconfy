-- ============================================================================
-- Apiconfy — MariaDB / MySQL schema
--
-- Run this ONCE with an account that has DDL rights, before starting the app:
--   mysql --user=<admin> --password --database=apiconfy < apps/server/src/core/db/schema/sql/mariadb.sql
--
-- The application never executes DDL. On startup it probes for the objects
-- below and exits with this file's path if any are missing.
--
-- Tables: component_definitions, workflow_definitions, workflow_steps,
--         executions, master_configuration   (all required)
--         execution_logs                      (optional — see the end of file)
--
-- Dialect notes (why this differs from postgres.sql):
--   * Keys and indexed columns are VARCHAR — TEXT cannot be a primary key or
--     take part in an index without a prefix length.
--   * JSON-shaped columns use MariaDB's JSON (LONGTEXT + json_valid CHECK).
--   * No column DEFAULT on the JSON columns: the adapter always supplies them,
--     and expression defaults are not portable across MySQL/MariaDB versions.
--   * Timestamps are ISO-8601 VARCHAR(32), matching every other adapter.
-- ============================================================================

-- ============================================================================
-- Table: component_definitions
-- Purpose: registered component definitions (REST APIs, queues, ...)
-- Why: every invocation resolves its config from here; (service, action) is the
--      natural key the registry upserts on
-- Written by: service registration; read by: the registry and invoke routes
-- ============================================================================
CREATE TABLE IF NOT EXISTS component_definitions (
  id VARCHAR(64) PRIMARY KEY,
  service VARCHAR(128) NOT NULL,
  action VARCHAR(128) NOT NULL,
  component_type VARCHAR(32) NOT NULL,
  description TEXT,
  config JSON NOT NULL,
  `condition` TEXT,
  meta_data JSON,
  version INTEGER NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS natural_key_idx ON component_definitions(service, action);

-- ============================================================================
-- Table: workflow_definitions
-- Purpose: composed workflows (Phase 5+ executes them)
-- Why: a workflow row plus its steps must exist together; name is unique
-- Written by: workflow registration; read by: the workflow and run routes
-- ============================================================================
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(191) NOT NULL UNIQUE,
  group_id VARCHAR(64),
  description TEXT,
  response_mapping JSON,
  max_duration_ms INTEGER,
  compensation_failure_config JSON,
  version INTEGER NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);

-- ============================================================================
-- Table: workflow_steps
-- Purpose: ordered steps belonging to a workflow
-- Why: step_order drives execution; component_id ties a step to a registered
--      component; steps die with their workflow (ON DELETE CASCADE)
-- Written by: workflow registration; read by: the workflow runner
-- ============================================================================
CREATE TABLE IF NOT EXISTS workflow_steps (
  id VARCHAR(64) PRIMARY KEY,
  workflow_id VARCHAR(64) NOT NULL,
  name VARCHAR(191),
  step_order INTEGER NOT NULL,
  step_group INTEGER NOT NULL DEFAULT 0,
  component_id VARCHAR(64) NOT NULL,
  depends_on_step_id VARCHAR(64),
  compensation_service VARCHAR(128),
  compensation_action VARCHAR(128),
  `condition` TEXT,
  on_failure VARCHAR(16) NOT NULL DEFAULT 'halt',
  idempotency_key_header VARCHAR(128),
  verify_action VARCHAR(128),
  CONSTRAINT fk_steps_workflow FOREIGN KEY (workflow_id)
    REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  CONSTRAINT fk_steps_component FOREIGN KEY (component_id)
    REFERENCES component_definitions(id)
);

-- ============================================================================
-- Table: executions
-- Purpose: one row per invocation (service or saga), plus saga step snapshots
-- Why: GET /api/v1/executions/:executionId reads it; attempts records the real
--      dispatch count, which is zero before any dispatch
-- Written by: the runtime executor; read by: the executions route
-- ============================================================================
CREATE TABLE IF NOT EXISTS executions (
  execution_id VARCHAR(64) PRIMARY KEY,
  type VARCHAR(16) NOT NULL,
  ref_name VARCHAR(191) NOT NULL,
  service VARCHAR(128),
  action VARCHAR(128),
  group_id VARCHAR(64),
  status VARCHAR(32) NOT NULL,
  context JSON NOT NULL,
  steps JSON,
  result JSON,
  max_duration_ms INTEGER,
  error_code VARCHAR(64),
  error_message TEXT,
  error_details JSON,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at VARCHAR(32) NOT NULL,
  completed_at VARCHAR(32),
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);

-- ============================================================================
-- Table: master_configuration
-- Purpose: runtime configuration key/value store
-- Why: setConfig is an upsert by key; nothing else persists master config
-- Written by: config writes; read by: config reads at startup and runtime
-- ============================================================================
CREATE TABLE IF NOT EXISTS master_configuration (
  id VARCHAR(64) PRIMARY KEY,
  `key` VARCHAR(191) NOT NULL UNIQUE,
  value TEXT NOT NULL,
  value_type VARCHAR(32) NOT NULL DEFAULT 'string',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);

-- ============================================================================
-- OPTIONAL — execution_logs
--
-- UNCOMMENT THIS BLOCK BEFORE RUNNING when ENABLE_DB_TRANSACTION_LOGS=true.
-- The startup probe requires this table whenever that flag is on, so leaving
-- it commented while the flag is set means the app will not start.
-- Without the flag the audit trail goes to console (pino) / OpenTelemetry —
-- see plans/logging.md.
--
-- Table: execution_logs
-- Purpose: one audit row per invocation
-- Correlation: matches executions.execution_id (no FK today)
-- ============================================================================
-- CREATE TABLE IF NOT EXISTS execution_logs (
--   id VARCHAR(64) PRIMARY KEY,
--   execution_id VARCHAR(64) NOT NULL,
--   workflow_name VARCHAR(191),
--   service VARCHAR(128),
--   action VARCHAR(128),
--   component_type VARCHAR(32),
--   step_order INTEGER,
--   status VARCHAR(16) NOT NULL,
--   request_data TEXT,
--   response_data TEXT,
--   error_message TEXT,
--   duration_ms INTEGER,
--   created_at VARCHAR(32) NOT NULL
-- );
