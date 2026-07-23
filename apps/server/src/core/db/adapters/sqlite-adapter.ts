import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq, and } from 'drizzle-orm';
import { generateId } from '@/lib/id.js';
import type { DBAdapter, ComponentRecord, WorkflowRecord, WorkflowStepRecord, ExecutionLogRecord } from '../adapter.js';
import * as schema from '../schema/index.js';

// TODO: replace with drizzle-kit migrations when ready to productionize.
// SCHEMA_SQL and schema/index.ts must stay in sync manually for now.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS component_definitions (
  id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL,
  service_type TEXT NOT NULL,
  component TEXT NOT NULL,
  description TEXT,
  service_details TEXT NOT NULL DEFAULT '{}',
  condition TEXT,
  meta_data TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS natural_key_idx ON component_definitions(service_name, component, service_type);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  response_mapping TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  step_group INTEGER NOT NULL DEFAULT 0,
  component_id TEXT NOT NULL REFERENCES component_definitions(id),
  depends_on_step_id TEXT,
  rollback_service_name TEXT,
  rollback_service_type TEXT,
  rollback_all_previous INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS execution_logs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  workflow_name TEXT,
  service_name TEXT,
  service_type TEXT,
  component TEXT,
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

function nullable<T>(v: T | null): T | undefined {
  return v === null ? undefined : v;
}

function toComponent(row: ComponentRow): ComponentRecord {
  return {
    id: row.id,
    serviceName: row.serviceName,
    serviceType: row.serviceType,
    component: row.component,
    description: nullable(row.description),
    serviceDetails: row.serviceDetails as Record<string, unknown>,
    condition: nullable(row.condition),
    metaData: nullable(row.metaData) as Record<string, unknown> | undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    name: row.name,
    description: nullable(row.description),
    responseMapping: nullable(row.responseMapping) as Record<string, unknown> | undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStep(row: StepRow): WorkflowStepRecord {
  return {
    id: row.id,
    workflowId: row.workflowId,
    stepOrder: row.stepOrder,
    stepGroup: row.stepGroup,
    componentId: row.componentId,
    dependsOnStepId: nullable(row.dependsOnStepId),
    rollbackServiceName: nullable(row.rollbackServiceName),
    rollbackServiceType: nullable(row.rollbackServiceType),
    rollbackAllPrevious: row.rollbackAllPrevious,
  };
}

function toLog(row: LogRow): ExecutionLogRecord {
  return {
    id: row.id,
    executionId: row.executionId,
    workflowName: nullable(row.workflowName),
    serviceName: nullable(row.serviceName),
    serviceType: nullable(row.serviceType),
    component: nullable(row.component),
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

    async saveComponent(comp) {
      const row = db.insert(t.componentDefinitions).values({
        id: comp.id,
        serviceName: comp.serviceName,
        serviceType: comp.serviceType,
        component: comp.component,
        description: comp.description ?? null,
        serviceDetails: comp.serviceDetails,
        condition: comp.condition ?? null,
        metaData: comp.metaData ?? null,
        createdAt: comp.createdAt,
        updatedAt: comp.updatedAt,
      }).returning().get();
      return toComponent(row);
    },

    async getComponent(id) {
      const row = db.select().from(t.componentDefinitions).where(eq(t.componentDefinitions.id, id)).get();
      return row ? toComponent(row) : null;
    },

    async findComponent(serviceName, component, serviceType) {
      const row = db.select().from(t.componentDefinitions).where(
        and(
          eq(t.componentDefinitions.serviceName, serviceName),
          eq(t.componentDefinitions.serviceType, serviceType),
          eq(t.componentDefinitions.component, component),
        )
      ).get();
      return row ? toComponent(row) : null;
    },

    async listComponents(filters, limit = 50, offset = 0) {
      const conditions: ReturnType<typeof eq>[] = [];
      if (filters?.serviceName) conditions.push(eq(t.componentDefinitions.serviceName, filters.serviceName));
      if (filters?.component) conditions.push(eq(t.componentDefinitions.component, filters.component));

      const rows = db.select().from(t.componentDefinitions)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(t.componentDefinitions.createdAt)
        .limit(limit).offset(offset)
        .all();
      return rows.map(toComponent);
    },

    async updateComponent(id, changes) {
      const ts = now();
      const set: Record<string, unknown> = { updatedAt: ts };
      if (changes.serviceName !== undefined) set.serviceName = changes.serviceName;
      if (changes.serviceType !== undefined) set.serviceType = changes.serviceType;
      if (changes.component !== undefined) set.component = changes.component;
      if (changes.description !== undefined) set.description = changes.description;
      if (changes.serviceDetails !== undefined) set.serviceDetails = changes.serviceDetails;
      if (changes.condition !== undefined) set.condition = changes.condition;
      if (changes.metaData !== undefined) set.metaData = changes.metaData;

      const rows = db.update(t.componentDefinitions).set(set).where(eq(t.componentDefinitions.id, id)).returning().all();
      if (!rows.length) throw new Error(`Component ${id} not found`);
      return toComponent(rows[0]);
    },

    async deleteComponent(id) {
      db.delete(t.componentDefinitions).where(eq(t.componentDefinitions.id, id)).run();
    },

    async saveWorkflow(wf) {
      const row = db.insert(t.workflowDefinitions).values({
        id: wf.id,
        name: wf.name,
        description: wf.description ?? null,
        responseMapping: wf.responseMapping ?? null,
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
        .orderBy(t.workflowDefinitions.createdAt)
        .limit(limit).offset(offset)
        .all();
      return rows.map(toWorkflow);
    },

    async updateWorkflow(id, changes) {
      const ts = now();
      const set: Record<string, unknown> = { updatedAt: ts };
      if (changes.name !== undefined) set.name = changes.name;
      if (changes.description !== undefined) set.description = changes.description;
      if (changes.responseMapping !== undefined) set.responseMapping = changes.responseMapping;

      const rows = db.update(t.workflowDefinitions).set(set).where(eq(t.workflowDefinitions.id, id)).returning().all();
      if (!rows.length) throw new Error(`Workflow ${id} not found`);
      return toWorkflow(rows[0]);
    },

    async deleteWorkflow(id) {
      db.delete(t.workflowDefinitions).where(eq(t.workflowDefinitions.id, id)).run();
    },

    async saveWorkflowStep(step) {
      const row = db.insert(t.workflowSteps).values({
        id: step.id,
        workflowId: step.workflowId,
        stepOrder: step.stepOrder,
        stepGroup: step.stepGroup,
        componentId: step.componentId,
        dependsOnStepId: step.dependsOnStepId ?? null,
        rollbackServiceName: step.rollbackServiceName ?? null,
        rollbackServiceType: step.rollbackServiceType ?? null,
        rollbackAllPrevious: step.rollbackAllPrevious,
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

    async saveExecutionLog(log) {
      const row = db.insert(t.executionLogs).values({
        id: log.id,
        executionId: log.executionId,
        workflowName: log.workflowName ?? null,
        serviceName: log.serviceName ?? null,
        serviceType: log.serviceType ?? null,
        component: log.component ?? null,
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
      db.delete(t.masterConfiguration).where(eq(t.masterConfiguration.key, key)).run();
    },
  };

  return adapter;
}
