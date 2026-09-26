import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { and, count, eq } from 'drizzle-orm';
import {
  AppError,
  ConflictError,
  ConnectionError,
  DatabaseError,
  NotFoundError,
  UnsupportedOperationError,
} from '@/lib/errors.js';
import { generateId } from '@/lib/id.js';
import type {
  ComponentFilters,
  ComponentRecord,
  DBAdapter,
  ExecutionLogRecord,
  ExecutionRecord,
  WorkflowRecord,
  WorkflowStepRecord,
} from '../adapter.js';
import * as schema from '../schema/mysql.js';

type MySqlDb = MySql2Database<typeof schema>;

const REQUIRED_TABLES = [
  'component_definitions',
  'workflow_definitions',
  'workflow_steps',
  'executions',
  'master_configuration',
];
const OPTIONAL_TABLES = ['execution_logs'];
const UNIQUE_INDEX = 'natural_key_idx';
const SCHEMA_FILE = 'apps/server/src/core/db/schema/sql/mariadb.sql';
const SCHEMA_URL = 'https://github.com/apiconfy/apiconfy/blob/main/apps/server/src/core/db/schema/sql/mariadb.sql';
const SCHEMA_COMMAND = `mysql --user=<admin> --password --database=apiconfy < ${SCHEMA_FILE}`;
const DUPLICATE_CODES = new Set(['ER_DUP_ENTRY']);
const DUPLICATE_ERRNOS = new Set([1062]);
const FK_CODES = new Set([
  'ER_NO_REFERENCED_ROW',
  'ER_NO_REFERENCED_ROW_2',
  'ER_ROW_IS_REFERENCED',
  'ER_ROW_IS_REFERENCED_2',
]);
const FK_ERRNOS = new Set([1216, 1217, 1451, 1452]);
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'PROTOCOL_CONNECTION_LOST',
  'ER_ACCESS_DENIED_ERROR',
  'ER_CON_COUNT_ERROR',
]);
const CONNECTION_ERRNOS = new Set([1040, 1045, 2002, 2003, 2006, 2013]);

/** mysql2 parses `mysql://`; both schemes mean MariaDB here. */
function normalizeUrl(databaseUrl: string): string {
  return databaseUrl.startsWith('mariadb://')
    ? `mysql://${databaseUrl.slice('mariadb://'.length)}`
    : databaseUrl;
}

function auditEnabled(): boolean {
  return process.env.ENABLE_DB_TRANSACTION_LOGS === 'true';
}

function redact(dsn: string): string {
  return dsn.replace(/\/\/[^@/]*@/, '//***@');
}

function translate(err: unknown, dsn: string): AppError {
  if (err instanceof AppError) return err;
  const { code = '', errno = 0, message = 'MariaDB error' } = (err ?? {}) as {
    code?: string;
    errno?: number;
    message?: string;
  };
  if (DUPLICATE_CODES.has(code) || DUPLICATE_ERRNOS.has(errno)) {
    return new ConflictError(message);
  }
  if (FK_CODES.has(code) || FK_ERRNOS.has(errno)) {
    return new ConflictError(message);
  }
  if (CONNECTION_CODES.has(code) || CONNECTION_ERRNOS.has(errno)) {
    return new ConnectionError(`MariaDB unavailable at ${redact(dsn)}: ${message}`);
  }
  return new DatabaseError(message);
}

function nullable<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

type ComponentRow = typeof schema.componentDefinitions.$inferSelect;
type WorkflowRow = typeof schema.workflowDefinitions.$inferSelect;
type StepRow = typeof schema.workflowSteps.$inferSelect;
type ExecutionRow = typeof schema.executions.$inferSelect;
type LogRow = typeof schema.executionLogs.$inferSelect;

function toComponent(row: ComponentRow): ComponentRecord {
  return {
    id: row.id,
    service: row.service,
    action: row.action,
    componentType: row.componentType,
    description: nullable(row.description),
    config: row.config,
    condition: nullable(row.condition),
    metaData: nullable(row.metaData),
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
    responseMapping: nullable(row.responseMapping),
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
    error: row.errorCode === null
      ? undefined
      : { code: row.errorCode, message: row.errorMessage ?? '', details: row.errorDetails },
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

function componentFilterCondition(filters?: ComponentFilters) {
  const conditions = [];
  if (filters?.service) conditions.push(eq(schema.componentDefinitions.service, filters.service));
  if (filters?.componentType) {
    conditions.push(eq(schema.componentDefinitions.componentType, filters.componentType));
  }
  return conditions.length ? and(...conditions) : undefined;
}

type AdapterMethods = Omit<DBAdapter, 'type' | 'connect' | 'disconnect' | 'transaction'>;

/**
 * The 23 schema-bearing methods, written once against an executor — pool or
 * transaction connection. MySQL/MariaDB have no RETURNING, so writes re-read
 * their row and use affectedRows to detect a miss.
 */
function buildMethods(getDb: () => MySqlDb, dsn: string): AdapterMethods {
  const guard = async <T>(run: (db: MySqlDb) => Promise<T>): Promise<T> => {
    try {
      return await run(getDb());
    } catch (err) {
      throw translate(err, dsn);
    }
  };
  const now = () => new Date().toISOString();

  const readComponent = async (db: MySqlDb, id: string): Promise<ComponentRecord> => {
    const rows = await db.select().from(schema.componentDefinitions)
      .where(eq(schema.componentDefinitions.id, id));
    return toComponent(rows[0]);
  };

  return {
    async saveComponent(comp: ComponentRecord): Promise<ComponentRecord> {
      return guard(async (db) => {
        await db.insert(schema.componentDefinitions).values({
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
        });
        return readComponent(db, comp.id);
      });
    },

    async getComponent(id: string): Promise<ComponentRecord | null> {
      return guard(async (db) => {
        const rows = await db.select().from(schema.componentDefinitions)
          .where(eq(schema.componentDefinitions.id, id));
        return rows[0] ? toComponent(rows[0]) : null;
      });
    },

    async findComponent(service: string, action: string): Promise<ComponentRecord | null> {
      return guard(async (db) => {
        const rows = await db.select().from(schema.componentDefinitions).where(
          and(
            eq(schema.componentDefinitions.service, service),
            eq(schema.componentDefinitions.action, action),
          )
        );
        return rows[0] ? toComponent(rows[0]) : null;
      });
    },

    async listComponents(filters?: ComponentFilters, limit = 50, offset = 0): Promise<ComponentRecord[]> {
      return guard(async (db) => {
        const rows = await db.select().from(schema.componentDefinitions)
          .where(componentFilterCondition(filters))
          .orderBy(schema.componentDefinitions.createdAt, schema.componentDefinitions.id)
          .limit(limit).offset(offset);
        return rows.map(toComponent);
      });
    },

    async countComponents(filters?: ComponentFilters): Promise<number> {
      return guard(async (db) => {
        const rows = await db.select({ value: count() }).from(schema.componentDefinitions)
          .where(componentFilterCondition(filters));
        return Number(rows[0]?.value ?? 0);
      });
    },

    async updateComponent(id: string, changes: Partial<ComponentRecord>): Promise<ComponentRecord> {
      return guard(async (db) => {
        const set: Record<string, unknown> = { updatedAt: now() };
        if ('service' in changes) set.service = changes.service;
        if ('action' in changes) set.action = changes.action;
        if ('componentType' in changes) set.componentType = changes.componentType;
        if ('description' in changes) set.description = changes.description ?? null;
        if ('config' in changes) set.config = changes.config;
        if ('condition' in changes) set.condition = changes.condition ?? null;
        if ('metaData' in changes) set.metaData = changes.metaData ?? null;
        set.version = (changes.version ?? 0) + 1;

        const [header] = await db.update(schema.componentDefinitions).set(set)
          .where(eq(schema.componentDefinitions.id, id));
        if (header.affectedRows === 0) throw new NotFoundError(`Component ${id} not found`);
        return readComponent(db, id);
      });
    },

    async deleteComponent(id: string): Promise<void> {
      return guard(async (db) => {
        const [header] = await db.delete(schema.componentDefinitions)
          .where(eq(schema.componentDefinitions.id, id));
        if (header.affectedRows === 0) throw new NotFoundError(`Component ${id} not found`);
      });
    },

    async saveWorkflow(wf: WorkflowRecord): Promise<WorkflowRecord> {
      return guard(async (db) => {
        await db.insert(schema.workflowDefinitions).values({
          id: wf.id,
          name: wf.name,
          groupId: wf.groupId ?? null,
          description: wf.description ?? null,
          responseMapping: wf.responseMapping ?? null,
          maxDurationMs: wf.maxDurationMs ?? null,
          compensationFailureConfig: wf.compensationFailureConfig ?? null,
          createdAt: wf.createdAt,
          updatedAt: wf.updatedAt,
        });
        const rows = await db.select().from(schema.workflowDefinitions)
          .where(eq(schema.workflowDefinitions.id, wf.id));
        return toWorkflow(rows[0]);
      });
    },

    async getWorkflow(id: string): Promise<WorkflowRecord | null> {
      return guard(async (db) => {
        const rows = await db.select().from(schema.workflowDefinitions)
          .where(eq(schema.workflowDefinitions.id, id));
        return rows[0] ? toWorkflow(rows[0]) : null;
      });
    },

    async findWorkflowByName(name: string): Promise<WorkflowRecord | null> {
      return guard(async (db) => {
        const rows = await db.select().from(schema.workflowDefinitions)
          .where(eq(schema.workflowDefinitions.name, name));
        return rows[0] ? toWorkflow(rows[0]) : null;
      });
    },

    async listWorkflows(limit = 50, offset = 0): Promise<WorkflowRecord[]> {
      return guard(async (db) => {
        const rows = await db.select().from(schema.workflowDefinitions)
          .orderBy(schema.workflowDefinitions.createdAt, schema.workflowDefinitions.id)
          .limit(limit).offset(offset);
        return rows.map(toWorkflow);
      });
    },

    async updateWorkflow(id: string, changes: Partial<WorkflowRecord>): Promise<WorkflowRecord> {
      return guard(async (db) => {
        const set: Record<string, unknown> = { updatedAt: now() };
        if (changes.name !== undefined) set.name = changes.name;
        if (changes.groupId !== undefined) set.groupId = changes.groupId;
        if (changes.description !== undefined) set.description = changes.description;
        if (changes.responseMapping !== undefined) set.responseMapping = changes.responseMapping;
        if (changes.maxDurationMs !== undefined) set.maxDurationMs = changes.maxDurationMs;
        if (changes.compensationFailureConfig !== undefined) {
          set.compensationFailureConfig = changes.compensationFailureConfig;
        }
        set.version = (changes.version ?? 0) + 1;

        const [header] = await db.update(schema.workflowDefinitions).set(set)
          .where(eq(schema.workflowDefinitions.id, id));
        if (header.affectedRows === 0) throw new NotFoundError(`Workflow ${id} not found`);
        const rows = await db.select().from(schema.workflowDefinitions)
          .where(eq(schema.workflowDefinitions.id, id));
        return toWorkflow(rows[0]);
      });
    },

    async deleteWorkflow(id: string): Promise<void> {
      return guard(async (db) => {
        const [header] = await db.delete(schema.workflowDefinitions)
          .where(eq(schema.workflowDefinitions.id, id));
        if (header.affectedRows === 0) throw new NotFoundError(`Workflow ${id} not found`);
      });
    },

    async saveWorkflowStep(step: WorkflowStepRecord): Promise<WorkflowStepRecord> {
      return guard(async (db) => {
        await db.insert(schema.workflowSteps).values({
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
        });
        const rows = await db.select().from(schema.workflowSteps)
          .where(eq(schema.workflowSteps.id, step.id));
        return toStep(rows[0]);
      });
    },

    async getWorkflowSteps(workflowId: string): Promise<WorkflowStepRecord[]> {
      return guard(async (db) => {
        const rows = await db.select().from(schema.workflowSteps)
          .where(eq(schema.workflowSteps.workflowId, workflowId))
          .orderBy(schema.workflowSteps.stepOrder, schema.workflowSteps.id);
        return rows.map(toStep);
      });
    },

    async deleteWorkflowSteps(workflowId: string): Promise<void> {
      return guard(async (db) => {
        await db.delete(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, workflowId));
      });
    },

    async saveExecution(record: ExecutionRecord): Promise<ExecutionRecord> {
      return guard(async (db) => {
        await db.insert(schema.executions).values({
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
        });
        const rows = await db.select().from(schema.executions)
          .where(eq(schema.executions.executionId, record.executionId));
        return toExecution(rows[0]);
      });
    },

    async getExecution(executionId: string): Promise<ExecutionRecord | null> {
      return guard(async (db) => {
        const rows = await db.select().from(schema.executions)
          .where(eq(schema.executions.executionId, executionId));
        return rows[0] ? toExecution(rows[0]) : null;
      });
    },

    async saveExecutionLog(log: ExecutionLogRecord): Promise<ExecutionLogRecord> {
      return guard(async (db) => {
        await db.insert(schema.executionLogs).values({
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
        });
        const rows = await db.select().from(schema.executionLogs)
          .where(eq(schema.executionLogs.id, log.id));
        return toLog(rows[0]);
      });
    },

    async getExecutionLogs(executionId: string): Promise<ExecutionLogRecord[]> {
      return guard(async (db) => {
        const rows = await db.select().from(schema.executionLogs)
          .where(eq(schema.executionLogs.executionId, executionId))
          .orderBy(schema.executionLogs.createdAt, schema.executionLogs.id);
        return rows.map(toLog);
      });
    },

    async getConfig(key: string): Promise<string | null> {
      return guard(async (db) => {
        const rows = await db.select({ value: schema.masterConfiguration.value })
          .from(schema.masterConfiguration)
          .where(eq(schema.masterConfiguration.key, key));
        return rows[0]?.value ?? null;
      });
    },

    async setConfig(key: string, value: string, valueType: string): Promise<void> {
      return guard(async (db) => {
        const ts = now();
        await db.insert(schema.masterConfiguration).values({
          id: generateId(),
          key,
          value,
          valueType,
          createdAt: ts,
          updatedAt: ts,
        }).onDuplicateKeyUpdate({
          set: { value, valueType, updatedAt: ts },
        });
      });
    },

    async deleteConfig(key: string): Promise<void> {
      return guard(async (db) => {
        const [header] = await db.delete(schema.masterConfiguration)
          .where(eq(schema.masterConfiguration.key, key));
        if (header.affectedRows === 0) throw new NotFoundError(`Config ${key} not found`);
      });
    },
  };
}

async function probeSchema(pool: Pool, dsn: string): Promise<string[]> {
  const required = [...REQUIRED_TABLES, ...(auditEnabled() ? OPTIONAL_TABLES : [])];
  const missing: string[] = [];

  try {
    const [tableRows] = await pool.query<RowDataPacket[]>(
      'SELECT table_name AS name FROM information_schema.tables '
      + 'WHERE table_schema = DATABASE() AND table_name IN (?)',
      [required]
    );
    const present = new Set(tableRows.map((row) => String(row.name)));
    missing.push(...required.filter((table) => !present.has(table)));

    if (!missing.includes('component_definitions')) {
      const [indexRows] = await pool.query<RowDataPacket[]>(
        'SELECT 1 FROM information_schema.statistics '
        + 'WHERE table_schema = DATABASE() AND index_name = ? LIMIT 1',
        [UNIQUE_INDEX]
      );
      if (indexRows.length === 0) missing.push(`${UNIQUE_INDEX} (unique index on component_definitions)`);
    }
  } catch (err) {
    throw translate(err, dsn);
  }

  if (missing.length) {
    throw new DatabaseError(
      `Database schema is not initialised — missing: ${missing.join(', ')}.\n`
      + `Run: ${SCHEMA_COMMAND}\n`
      + `Script: ${SCHEMA_FILE}\n`
      + `GitHub: ${SCHEMA_URL}`
    );
  }

  return required;
}

export async function createMariaDbAdapter(databaseUrl: string): Promise<DBAdapter> {
  const dsn = normalizeUrl(databaseUrl);
  const pool = mysql.createPool({ uri: dsn, connectionLimit: 10, connectTimeout: 10_000 });
  const db = drizzle(pool, { schema, mode: 'default' });
  const methods = buildMethods(() => db, databaseUrl);

  return {
    type: 'mysql',
    ...methods,

    async connect(): Promise<void> {
      await probeSchema(pool, databaseUrl);
    },

    async disconnect(): Promise<void> {
      await pool.end();
    },

    async transaction<T>(fn: (tx: DBAdapter) => Promise<T>): Promise<T> {
      const connection: PoolConnection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const txDb = drizzle(connection, { schema, mode: 'default' }) as unknown as MySqlDb;
        const txAdapter: DBAdapter = {
          type: 'mysql',
          ...buildMethods(() => txDb, databaseUrl),
          async connect(): Promise<void> {},
          async disconnect(): Promise<void> {},
          async transaction<R>(): Promise<R> {
            throw new UnsupportedOperationError('Nested transactions are not supported');
          },
        };
        const result = await fn(txAdapter);
        await connection.commit();
        return result;
      } catch (err) {
        await connection.rollback();
        throw translate(err, databaseUrl);
      } finally {
        connection.release();
      }
    },
  };
}
