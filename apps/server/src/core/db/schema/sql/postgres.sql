-- ============================================================================
-- Apiconfy — PostgreSQL schema
--
-- Run this ONCE with an account that has DDL rights, before starting the app:
--   psql -f apps/server/src/core/db/schema/sql/postgres.sql
--
-- The application never executes DDL. On startup it probes for the objects
-- below and exits with this file's path if any are missing.
--
-- Tables: component_definitions, workflow_definitions, workflow_steps,
--         executions, master_configuration   (all required)
--         execution_logs                      (optional — see the end of file)
--
-- JSON-shaped columns are JSONB so the driver round-trips objects natively.
-- Timestamps are ISO-8601 TEXT, matching every other adapter.
-- ============================================================================

-- ============================================================================
-- Table: component_definitions
-- Purpose: registered component definitions (REST APIs, queues, ...)
-- Why: every invocation resolves its config from here; (service, action) is the
--      natural key the registry upserts on
-- Written by: service registration; read by: the registry and invoke routes
-- ============================================================================
CREATE TABLE IF NOT EXISTS component_definitions (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  action TEXT NOT NULL,
  component_type TEXT NOT NULL,
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  condition TEXT,
  meta_data JSONB DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS natural_key_idx ON component_definitions(service, action);

-- ============================================================================
-- Table: workflow_definitions
-- Purpose: composed workflows (Phase 5+ executes them)
-- Why: a workflow row plus its steps must exist together; name is unique
-- Written by: workflow registration; read by: the workflow and run routes
-- ============================================================================
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  group_id TEXT,
  description TEXT,
  response_mapping JSONB DEFAULT '{}',
  max_duration_ms INTEGER,
  compensation_failure_config JSONB,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- Table: workflow_steps
-- Purpose: ordered steps belonging to a workflow
-- Why: step_order drives execution; component_id ties a step to a registered
--      component; steps die with their workflow (ON DELETE CASCADE)
-- Written by: workflow registration; read by: the workflow runner
-- ============================================================================
CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  name TEXT,
  step_order INTEGER NOT NULL,
  step_group INTEGER NOT NULL DEFAULT 0,
  component_id TEXT NOT NULL REFERENCES component_definitions(id),
  depends_on_step_id TEXT,
  compensation_service TEXT,
  compensation_action TEXT,
  condition TEXT,
  on_failure TEXT NOT NULL DEFAULT 'halt',
  idempotency_key_header TEXT,
  verify_action TEXT
);

-- ============================================================================
-- Table: executions
-- Purpose: one row per invocation (service or saga), plus saga step snapshots
-- Why: GET /api/v1/executions/:executionId reads it; attempts records the real
--      dispatch count, which is zero before any dispatch
-- Written by: the runtime executor; read by: the executions route
-- ============================================================================
CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  service TEXT,
  action TEXT,
  group_id TEXT,
  status TEXT NOT NULL,
  context JSONB NOT NULL,
  steps JSONB,
  result JSONB,
  max_duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  error_details JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- Table: master_configuration
-- Purpose: runtime configuration key/value store
-- Why: setConfig is an upsert by key; nothing else persists master config
-- Written by: config writes; read by: config reads at startup and runtime
-- ============================================================================
CREATE TABLE IF NOT EXISTS master_configuration (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
--   id TEXT PRIMARY KEY,
--   execution_id TEXT NOT NULL,
--   workflow_name TEXT,
--   service TEXT,
--   action TEXT,
--   component_type TEXT,
--   step_order INTEGER,
--   status TEXT NOT NULL,
--   request_data TEXT,
--   response_data TEXT,
--   error_message TEXT,
--   duration_ms INTEGER,
--   created_at TEXT NOT NULL
-- );
