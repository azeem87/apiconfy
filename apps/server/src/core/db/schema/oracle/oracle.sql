-- ============================================================================
-- Apiconfy — Oracle schema
--
-- Run this ONCE with an account that has DDL rights, before starting the app:
--   sqlplus <admin>@//host:1521/service @apps/server/src/core/db/schema/oracle/oracle.sql
--
-- The application never executes DDL. On startup it probes `user_tables` /
-- `user_indexes` and exits with this file's path if anything is missing.
--
-- Tables: COMPONENT_DEFINITIONS, WORKFLOW_DEFINITIONS, WORKFLOW_STEPS,
--         EXECUTIONS, MASTER_CONFIGURATION   (all required)
--         EXECUTION_LOGS                     (optional — see the end of file)
--
-- Dialect notes:
--   * Identifiers are unquoted, so Oracle stores them UPPERCASE — the adapter
--     and its probe use uppercase names.
--   * JSON-shaped columns are VARCHAR2 (ISO text) and are stringified/parsed by
--     the adapter; Oracle has no JSON column type in this column set.
--   * There is no CREATE TABLE IF NOT EXISTS, so each block swallows ORA-00955
--     ("name is already used") to stay re-runnable.
--   * Timestamps are ISO-8601 VARCHAR2(32), matching every other adapter.
-- ============================================================================

-- ============================================================================
-- Table: COMPONENT_DEFINITIONS
-- Purpose: registered component definitions (REST APIs, queues, ...)
-- Why: every invocation resolves its config from here; (SERVICE, ACTION) is the
--      natural key the registry upserts on
-- Written by: service registration; read by: the registry and invoke routes
-- ============================================================================
DECLARE
  e_exists EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_exists, -955);
BEGIN
  EXECUTE IMMEDIATE '
    CREATE TABLE component_definitions (
      id VARCHAR2(64) PRIMARY KEY,
      service VARCHAR2(128) NOT NULL,
      action VARCHAR2(128) NOT NULL,
      component_type VARCHAR2(32) NOT NULL,
      description VARCHAR2(1000),
      config CLOB NOT NULL,
      condition VARCHAR2(1000),
      meta_data CLOB,
      version NUMBER(10) DEFAULT 1 NOT NULL,
      created_at VARCHAR2(32) NOT NULL,
      updated_at VARCHAR2(32) NOT NULL
    )';
EXCEPTION WHEN e_exists THEN NULL;
END;
/

DECLARE
  e_exists EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_exists, -955);
BEGIN
  EXECUTE IMMEDIATE
    'CREATE UNIQUE INDEX natural_key_idx ON component_definitions(service, action)';
EXCEPTION WHEN e_exists THEN NULL;
END;
/

-- ============================================================================
-- Table: WORKFLOW_DEFINITIONS
-- Purpose: composed workflows (Phase 5+ executes them)
-- Why: a workflow row plus its steps must exist together; NAME is unique
-- Written by: workflow registration; read by: the workflow and run routes
-- ============================================================================
DECLARE
  e_exists EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_exists, -955);
BEGIN
  EXECUTE IMMEDIATE '
    CREATE TABLE workflow_definitions (
      id VARCHAR2(64) PRIMARY KEY,
      name VARCHAR2(191) NOT NULL UNIQUE,
      group_id VARCHAR2(64),
      description VARCHAR2(1000),
      response_mapping CLOB,
      max_duration_ms NUMBER(10),
      compensation_failure_config CLOB,
      version NUMBER(10) DEFAULT 1 NOT NULL,
      created_at VARCHAR2(32) NOT NULL,
      updated_at VARCHAR2(32) NOT NULL
    )';
EXCEPTION WHEN e_exists THEN NULL;
END;
/

-- ============================================================================
-- Table: WORKFLOW_STEPS
-- Purpose: ordered steps belonging to a workflow
-- Why: STEP_ORDER drives execution; COMPONENT_ID ties a step to a registered
--      component; steps die with their workflow (ON DELETE CASCADE)
-- Written by: workflow registration; read by: the workflow runner
-- ============================================================================
DECLARE
  e_exists EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_exists, -955);
BEGIN
  EXECUTE IMMEDIATE '
    CREATE TABLE workflow_steps (
      id VARCHAR2(64) PRIMARY KEY,
      workflow_id VARCHAR2(64) NOT NULL,
      name VARCHAR2(191),
      step_order NUMBER(10) NOT NULL,
      step_group NUMBER(10) DEFAULT 0 NOT NULL,
      component_id VARCHAR2(64) NOT NULL,
      depends_on_step_id VARCHAR2(64),
      compensation_service VARCHAR2(128),
      compensation_action VARCHAR2(128),
      condition VARCHAR2(1000),
      on_failure VARCHAR2(16) DEFAULT ''halt'' NOT NULL,
      idempotency_key_header VARCHAR2(128),
      verify_action VARCHAR2(128),
      CONSTRAINT fk_steps_workflow FOREIGN KEY (workflow_id)
        REFERENCES workflow_definitions(id) ON DELETE CASCADE,
      CONSTRAINT fk_steps_component FOREIGN KEY (component_id)
        REFERENCES component_definitions(id)
    )';
EXCEPTION WHEN e_exists THEN NULL;
END;
/

-- ============================================================================
-- Table: EXECUTIONS
-- Purpose: one row per invocation (service or saga), plus saga step snapshots
-- Why: GET /api/v1/executions/:executionId reads it; ATTEMPTS records the real
--      dispatch count, which is zero before any dispatch
-- Written by: the runtime executor; read by: the executions route
-- ============================================================================
DECLARE
  e_exists EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_exists, -955);
BEGIN
  EXECUTE IMMEDIATE '
    CREATE TABLE executions (
      execution_id VARCHAR2(64) PRIMARY KEY,
      type VARCHAR2(16) NOT NULL,
      ref_name VARCHAR2(191) NOT NULL,
      service VARCHAR2(128),
      action VARCHAR2(128),
      group_id VARCHAR2(64),
      status VARCHAR2(32) NOT NULL,
      context CLOB NOT NULL,
      steps CLOB,
      result CLOB,
      max_duration_ms NUMBER(10),
      error_code VARCHAR2(64),
      error_message VARCHAR2(1000),
      error_details CLOB,
      attempts NUMBER(10) DEFAULT 0 NOT NULL,
      started_at VARCHAR2(32) NOT NULL,
      completed_at VARCHAR2(32),
      created_at VARCHAR2(32) NOT NULL,
      updated_at VARCHAR2(32) NOT NULL
    )';
EXCEPTION WHEN e_exists THEN NULL;
END;
/

-- ============================================================================
-- Table: MASTER_CONFIGURATION
-- Purpose: runtime configuration key/value store
-- Why: setConfig is a MERGE by key; nothing else persists master config
-- Written by: config writes; read by: config reads at startup and runtime
-- ============================================================================
DECLARE
  e_exists EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_exists, -955);
BEGIN
  EXECUTE IMMEDIATE '
    CREATE TABLE master_configuration (
      id VARCHAR2(64) PRIMARY KEY,
      key VARCHAR2(191) NOT NULL UNIQUE,
      value CLOB NOT NULL,
      value_type VARCHAR2(32) DEFAULT ''string'' NOT NULL,
      created_at VARCHAR2(32) NOT NULL,
      updated_at VARCHAR2(32) NOT NULL
    )';
EXCEPTION WHEN e_exists THEN NULL;
END;
/

-- ============================================================================
-- OPTIONAL — EXECUTION_LOGS
--
-- UNCOMMENT THIS BLOCK BEFORE RUNNING when ENABLE_DB_TRANSACTION_LOGS=true.
-- The startup probe requires this table whenever that flag is on, so leaving
-- it commented while the flag is set means the app will not start.
-- Without the flag the audit trail goes to console (pino) / OpenTelemetry —
-- see plans/logging.md.
--
-- Table: EXECUTION_LOGS
-- Purpose: one audit row per invocation
-- Correlation: matches EXECUTIONS.EXECUTION_ID (no FK today)
-- ============================================================================
-- DECLARE
--   e_exists EXCEPTION;
--   PRAGMA EXCEPTION_INIT(e_exists, -955);
-- BEGIN
--   EXECUTE IMMEDIATE '
--     CREATE TABLE execution_logs (
--       id VARCHAR2(64) PRIMARY KEY,
--       execution_id VARCHAR2(64) NOT NULL,
--       workflow_name VARCHAR2(191),
--       service VARCHAR2(128),
--       action VARCHAR2(128),
--       component_type VARCHAR2(32),
--       step_order NUMBER(10),
--       status VARCHAR2(16) NOT NULL,
--       request_data CLOB,
--       response_data CLOB,
--       error_message VARCHAR2(1000),
--       duration_ms NUMBER(10),
--       created_at VARCHAR2(32) NOT NULL
--     )';
-- EXCEPTION WHEN e_exists THEN NULL;
-- END;
-- /
