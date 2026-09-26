import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq, and, count } from 'drizzle-orm';
import { generateId } from '@/lib/id.js';
import { AppError, ConflictError, NotFoundError } from '@/lib/errors.js';
import type { DBAdapter, ComponentRecord, ComponentFilters, WorkflowRecord, WorkflowStepRecord, ExecutionRecord, ExecutionLogRecord } from '../adapter.js';
import * as schema from '../schema/index.js';

// TODO: replace with drizzle-kit migrations when ready to productionize.
// SCHEMA_SQL and schema/index.ts must stay in sync manually for now.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS component_definitions (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  action TEXT NOT NULL,
  component_type TEXT NOT NULL,
  description TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  condition TEXT,
  meta_data TEXT DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS natural_key_idx ON component_definitions(service, action);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  group_id TEXT,
  description TEXT,
  response_mapping TEXT DEFAULT '{}',
  max_duration_ms INTEGER,
  compensation_failure_config TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  service TEXT,
  action TEXT,
  group_id TEXT,
  status TEXT NOT NULL,
  context TEXT NOT NULL,
  steps TEXT,
  result TEXT,
  max_duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  error_details TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_logs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  workflow_name TEXT,
  service TEXT,
  action TEXT,
  component_type TEXT,
  step_order INTEGER,
  status TEXT NOT NULL,
  request_data TEXT,
  response_data TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS master_configuration (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'string',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

type ComponentRow = typeof schema.componentDefinitions.$inferSelect;
type WorkflowRow = typeof schema.workflowDefinitions.$inferSelect;
type StepRow = typeof schema.workflowSteps.$inferSelect;
type LogRow = typeof schema.executionLogs.$inferSelect;
type ExecutionRow = typeof schema.executions.$inferSelect;

function nullable<T>(v: T | null): T | undefined {
  return v === null ? undefined : v;
}

function toComponent(row: ComponentRow): ComponentRecord {
  return {
    id: row.id,
    service: row.service,
    action: row.action,
    componentType: row.componentType,
    description: nullable(row.description),
    config: row.config as Record<string, unknown>,
    condition: nullable(row.condition),
    metaData: nullable(row.metaData) as Record<string, unknown> | undefined,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    name: row.name,
    groupId: nullable(row.groupId),
    description: nullable(row.description),
    responseMapping: nullable(row.responseMapping) as Record<string, unknown> | undefined,
    maxDurationMs: nullable(row.maxDurationMs),
    compensationFailureConfig: nullable(row.compensationFailureConfig),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStep(row: StepRow): WorkflowStepRecord {
  return {
    id: row.id,
    workflowId: row.workflowId,
    name: nullable(row.name),
    stepOrder: row.stepOrder,
    stepGroup: row.stepGroup,
    componentId: row.componentId,
    dependsOnStepId: nullable(row.dependsOnStepId),
    compensationService: nullable(row.compensationService),
    compensationAction: nullable(row.compensationAction),
    condition: nullable(row.condition),
    onFailure: row.onFailure,
    idempotencyKeyHeader: nullable(row.idempotencyKeyHeader),
    verifyAction: nullable(row.verifyAction),
  };
}

function toExecution(row: ExecutionRow): ExecutionRecord {
  return {
    executionId: row.executionId,
    type: row.type,
    refName: row.refName,
    service: nullable(row.service),
    action: nullable(row.action),
    groupId: nullable(row.groupId),
    status: row.status,
    context: row.context,
    steps: nullable(row.steps),
    result: row.result,
    maxDurationMs: nullable(row.maxDurationMs),
    error: row.errorCode === null ? undefined : {
      code: row.errorCode,
      message: row.errorMessage ?? '',
      details: row.errorDetails,
    },
    attempts: nullable(row.attempts),
    startedAt: row.startedAt,
    completedAt: nullable(row.completedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toLog(row: LogRow): ExecutionLogRecord {
  return {
    id: row.id,
    executionId: row.executionId,
    workflowName: nullable(row.workflowName),
    service: nullable(row.service),
    action: nullable(row.action),
    componentType: nullable(row.componentType),
    stepOrder: nullable(row.stepOrder),
    status: row.status,
    requestData: nullable(row.requestData),
    responseData: nullable(row.responseData),
    errorMessage: nullable(row.errorMessage),
    durationMs: nullable(row.durationMs),
    createdAt: row.createdAt,
  };
}

function now(): string {
  return new Date().toISOString();
}

/** Constraint failures become domain errors; everything else is rethrown unchanged. */
function translateSqliteError(err: unknown): Error {
  if (err instanceof AppError) return err;
  const { code = '', message = 'SQLite error' } = (err ?? {}) as { code?: string; message?: string };
  if (code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || message.includes('UNIQUE constraint failed')) {
    return new ConflictError(message);
  }
  if (code.startsWith('SQLITE_CONSTRAINT_FOREIGNKEY') || message.includes('FOREIGN KEY constraint failed')) {
    return new ConflictError(message);
  }
  return err instanceof Error ? err : new Error(message);
}

function componentFilters(
  t: typeof schema,
  filters?: ComponentFilters
) {
  const conditions: ReturnType<typeof eq>[] = [];
  if (filters?.service) conditions.push(eq(t.componentDefinitions.service, filters.service));
  if (filters?.componentType) conditions.push(eq(t.componentDefinitions.componentType, filters.componentType));
  return conditions.length ? and(...conditions) : undefined;
}

export function createSqliteAdapter(pathOrDb?: string | Database): DBAdapter {
  let sqliteDb: Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const t = schema;

  const adapter: DBAdapter = {
    type: 'sqlite',

    async connect() {
      const dbPath = typeof pathOrDb === 'object' ? ':memory:' : (pathOrDb ?? './data/apiconfy.db');
      sqliteDb = typeof pathOrDb === 'object' ? pathOrDb : new Database(dbPath, { create: true });
      sqliteDb.exec('PRAGMA journal_mode=WAL');
      sqliteDb.exec('PRAGMA foreign_keys=ON');
      sqliteDb.exec(SCHEMA_SQL);
      db = drizzle(sqliteDb, { schema });
    },

    async disconnect() {
      sqliteDb.close();
    },

    /** One connection: the callback can reuse this adapter and stay inside the transaction. */
    async transaction<T>(fn: (tx: DBAdapter) => Promise<T>): Promise<T> {
      sqliteDb.exec('BEGIN');
      try {
        const result = await fn(adapter);
        sqliteDb.exec('COMMIT');
        return result;
      } catch (err) {
        sqliteDb.exec('ROLLBACK');
        throw translateSqliteError(err);
      }
    },

    async saveComponent(comp) {
      try {
        const row = db.insert(t.componentDefinitions).values({
          id: comp.id,
          service: comp.service,
          action: comp.action,
          componentType: comp.componentType,
          description: comp.description ?? null,
          config: comp.config,
          condition: comp.condition ?? null,
          metaData: comp.metaData ?? null,
          createdAt: comp.createdAt,
          updatedAt: comp.updatedAt,
        }).returning().get();
        return toComponent(row);
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    async getComponent(id) {
      const row = db.select().from(t.componentDefinitions).where(eq(t.componentDefinitions.id, id)).get();
      return row ? toComponent(row) : null;
    },

    async findComponent(service, action) {
      const row = db.select().from(t.componentDefinitions).where(
        and(
          eq(t.componentDefinitions.service, service),
          eq(t.componentDefinitions.action, action),
        )
      ).get();
      return row ? toComponent(row) : null;
    },

    async listComponents(filters, limit = 50, offset = 0) {
      const rows = db.select().from(t.componentDefinitions)
        .where(componentFilters(t, filters))
        .orderBy(t.componentDefinitions.createdAt, t.componentDefinitions.id)
        .limit(limit).offset(offset)
        .all();
      return rows.map(toComponent);
    },

    async countComponents(filters) {
      const row = db.select({ value: count() }).from(t.componentDefinitions)
        .where(componentFilters(t, filters))
        .get();
      return row?.value ?? 0;
    },

    async updateComponent(id, changes) {
      const ts = now();
      const set: Record<string, unknown> = { updatedAt: ts };
      if ('service' in changes) set.service = changes.service;
      if ('action' in changes) set.action = changes.action;
      if ('componentType' in changes) set.componentType = changes.componentType;
      if ('description' in changes) set.description = changes.description ?? null;
      if ('config' in changes) set.config = changes.config;
      if ('condition' in changes) set.condition = changes.condition ?? null;
      if ('metaData' in changes) set.metaData = changes.metaData ?? null;
      
      // Always increment version on update
      set.version = (changes.version ?? 0) + 1;

      const rows = db.update(t.componentDefinitions).set(set).where(eq(t.componentDefinitions.id, id)).returning().all();
      if (!rows.length) throw new NotFoundError(`Component ${id} not found`);
      return toComponent(rows[0]);
    },

    async deleteComponent(id) {
      try {
        const rows = db.delete(t.componentDefinitions)
          .where(eq(t.componentDefinitions.id, id))
          .returning({ id: t.componentDefinitions.id }).all();
        if (!rows.length) throw new NotFoundError(`Component ${id} not found`);
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    async saveWorkflow(wf) {
      const row = db.insert(t.workflowDefinitions).values({
        id: wf.id,
        name: wf.name,
        groupId: wf.groupId ?? null,
        description: wf.description ?? null,
        responseMapping: wf.responseMapping ?? null,
        maxDurationMs: wf.maxDurationMs ?? null,
        compensationFailureConfig: wf.compensationFailureConfig ?? null,
        createdAt: wf.createdAt,
        updatedAt: wf.updatedAt,
      }).returning().get();
      return toWorkflow(row);
    },

    async getWorkflow(id) {
      const row = db.select().from(t.workflowDefinitions).where(eq(t.workflowDefinitions.id, id)).get();
      return row ? toWorkflow(row) : null;
    },

    async findWorkflowByName(name) {
      const row = db.select().from(t.workflowDefinitions).where(eq(t.workflowDefinitions.name, name)).get();
      return row ? toWorkflow(row) : null;
    },

    async listWorkflows(limit = 50, offset = 0) {
      const rows = db.select().from(t.workflowDefinitions)
        .orderBy(t.workflowDefinitions.createdAt, t.workflowDefinitions.id)
        .limit(limit).offset(offset)
        .all();
      return rows.map(toWorkflow);
    },

    async updateWorkflow(id, changes) {
      const ts = now();
      const set: Record<string, unknown> = { updatedAt: ts };
      if (changes.name !== undefined) set.name = changes.name;
      if (changes.groupId !== undefined) set.groupId = changes.groupId;
      if (changes.description !== undefined) set.description = changes.description;
      if (changes.responseMapping !== undefined) set.responseMapping = changes.responseMapping;
      if (changes.maxDurationMs !== undefined) set.maxDurationMs = changes.maxDurationMs;
      if (changes.compensationFailureConfig !== undefined) set.compensationFailureConfig = changes.compensationFailureConfig;
      
      // Always increment version on update
      set.version = (changes.version ?? 0) + 1;

      const rows = db.update(t.workflowDefinitions).set(set).where(eq(t.workflowDefinitions.id, id)).returning().all();
      if (!rows.length) throw new NotFoundError(`Workflow ${id} not found`);
      return toWorkflow(rows[0]);
    },

    async deleteWorkflow(id) {
      const rows = db.delete(t.workflowDefinitions)
        .where(eq(t.workflowDefinitions.id, id))
        .returning({ id: t.workflowDefinitions.id }).all();
      if (!rows.length) throw new NotFoundError(`Workflow ${id} not found`);
    },

    async saveWorkflowStep(step) {
      const row = db.insert(t.workflowSteps).values({
        id: step.id,
        workflowId: step.workflowId,
        name: step.name ?? null,
        stepOrder: step.stepOrder,
        stepGroup: step.stepGroup,
        componentId: step.componentId,
        dependsOnStepId: step.dependsOnStepId ?? null,
        compensationService: step.compensationService ?? null,
        compensationAction: step.compensationAction ?? null,
        condition: step.condition ?? null,
        onFailure: step.onFailure,
        idempotencyKeyHeader: step.idempotencyKeyHeader ?? null,
        verifyAction: step.verifyAction ?? null,
      }).returning().get();
      return toStep(row);
    },

    async getWorkflowSteps(workflowId) {
      const rows = db.select().from(t.workflowSteps)
        .where(eq(t.workflowSteps.workflowId, workflowId))
        .orderBy(t.workflowSteps.stepOrder)
        .all();
      return rows.map(toStep);
    },

    async deleteWorkflowSteps(workflowId) {
      db.delete(t.workflowSteps).where(eq(t.workflowSteps.workflowId, workflowId)).run();
    },

    async saveExecution(record) {
      const row = db.insert(t.executions).values({
        executionId: record.executionId,
        type: record.type,
        refName: record.refName,
        service: record.service ?? null,
        action: record.action ?? null,
        groupId: record.groupId ?? null,
        status: record.status,
        context: record.context,
        steps: record.steps ?? null,
        result: record.result ?? null,
        maxDurationMs: record.maxDurationMs ?? null,
        errorCode: record.error?.code ?? null,
        errorMessage: record.error?.message ?? null,
        errorDetails: record.error?.details ?? null,
        attempts: record.attempts ?? 0,
        startedAt: record.startedAt,
        completedAt: record.completedAt ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }).returning().get();
      return toExecution(row);
    },

    async getExecution(executionId) {
      const row = db.select().from(t.executions)
        .where(eq(t.executions.executionId, executionId)).get();
      return row ? toExecution(row) : null;
    },

    async saveExecutionLog(log) {
      const row = db.insert(t.executionLogs).values({
        id: log.id,
        executionId: log.executionId,
        workflowName: log.workflowName ?? null,
        service: log.service ?? null,
        action: log.action ?? null,
        componentType: log.componentType ?? null,
        stepOrder: log.stepOrder ?? null,
        status: log.status,
        requestData: log.requestData ?? null,
        responseData: log.responseData ?? null,
        errorMessage: log.errorMessage ?? null,
        durationMs: log.durationMs ?? null,
        createdAt: log.createdAt,
      }).returning().get();
      return toLog(row);
    },

    async getExecutionLogs(executionId) {
      const rows = db.select().from(t.executionLogs)
        .where(eq(t.executionLogs.executionId, executionId))
        .orderBy(t.executionLogs.createdAt)
        .all();
      return rows.map(toLog);
    },

    async getConfig(key) {
      const row = db.select({ value: t.masterConfiguration.value })
        .from(t.masterConfiguration)
        .where(eq(t.masterConfiguration.key, key))
        .get();
      return row?.value ?? null;
    },

    async setConfig(key, value, valueType) {
      const ts = now();
      const existing = db.select({ id: t.masterConfiguration.id })
        .from(t.masterConfiguration)
        .where(eq(t.masterConfiguration.key, key))
        .get();

      if (existing) {
        db.update(t.masterConfiguration)
          .set({ value, valueType, updatedAt: ts })
          .where(eq(t.masterConfiguration.id, existing.id))
          .run();
      } else {
        db.insert(t.masterConfiguration).values({
          id: generateId(),
          key,
          value,
          valueType,
          createdAt: ts,
          updatedAt: ts,
        }).run();
      }
    },

    async deleteConfig(key) {
      const rows = db.delete(t.masterConfiguration)
        .where(eq(t.masterConfiguration.key, key))
        .returning({ id: t.masterConfiguration.id }).all();
      if (!rows.length) throw new NotFoundError(`Config ${key} not found`);
    },
  };

  return adapter;
}
