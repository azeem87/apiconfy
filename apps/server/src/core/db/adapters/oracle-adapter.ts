import oracledb from 'oracledb';
import type { Connection, Pool } from 'oracledb';
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

const REQUIRED_TABLES = [
  'COMPONENT_DEFINITIONS',
  'WORKFLOW_DEFINITIONS',
  'WORKFLOW_STEPS',
  'EXECUTIONS',
  'MASTER_CONFIGURATION',
];
const OPTIONAL_TABLES = ['EXECUTION_LOGS'];
const UNIQUE_INDEX = 'NATURAL_KEY_IDX';
const SCHEMA_FILE = 'apps/server/src/core/db/schema/oracle/oracle.sql';
const SCHEMA_URL = 'https://github.com/apiconfy/apiconfy/blob/main/apps/server/src/core/db/schema/oracle/oracle.sql';
const SCHEMA_COMMAND = `sqlplus <admin>@//host:1521/service @${SCHEMA_FILE}`;
const DUPLICATE_ERRNOS = new Set([1]);
const FK_ERRNOS = new Set([2291, 2292]);
const CONNECTION_ERRNOS = new Set([3113, 3114, 12170, 12514, 12537, 12541, 12545, 12547, 12154]);

// CLOB columns (config, context, result, …) must arrive as strings, not Lob
// streams, so the mappers can parse them exactly like the other adapters.
oracledb.fetchAsString = [oracledb.CLOB];

function auditEnabled(): boolean {
  return process.env.ENABLE_DB_TRANSACTION_LOGS === 'true';
}

function translate(err: unknown, dsn: string): AppError {
  if (err instanceof AppError) return err;
  const { code = '', errorNum = 0, message = 'Oracle error' } = (err ?? {}) as {
    code?: string;
    errorNum?: number;
    message?: string;
  };
  const redacted = dsn.replace(/\/\/[^@/]*@/, '//***@');
  if (DUPLICATE_ERRNOS.has(errorNum) || code === 'ORA-00001') {
    return new ConflictError(message);
  }
  if (FK_ERRNOS.has(errorNum) || code === 'ORA-02291' || code === 'ORA-02292') {
    return new ConflictError(message);
  }
  if (code.startsWith('NJS-') || CONNECTION_ERRNOS.has(errorNum) || code === 'ECONNREFUSED') {
    return new ConnectionError(`Oracle unavailable at ${redacted}: ${message}`);
  }
  return new DatabaseError(message);
}

function parseJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

type Row = Record<string, unknown>;

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const maybe = (value: unknown): string | undefined => {
  const s = str(value);
  return s === '' ? undefined : s;
};
const num = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
};

function toComponent(row: Row): ComponentRecord {
  return {
    id: str(row.ID),
    service: str(row.SERVICE),
    action: str(row.ACTION),
    componentType: str(row.COMPONENT_TYPE),
    description: maybe(row.DESCRIPTION),
    config: (parseJson<Record<string, unknown>>(row.CONFIG) ?? {}) as Record<string, unknown>,
    condition: maybe(row.CONDITION),
    metaData: parseJson<Record<string, unknown>>(row.META_DATA),
    version: num(row.VERSION) ?? 1,
    createdAt: str(row.CREATED_AT),
    updatedAt: str(row.UPDATED_AT),
  };
}

function toWorkflow(row: Row): WorkflowRecord {
  return {
    id: str(row.ID),
    name: str(row.NAME),
    groupId: maybe(row.GROUP_ID),
    description: maybe(row.DESCRIPTION),
    responseMapping: parseJson<Record<string, unknown>>(row.RESPONSE_MAPPING),
    maxDurationMs: num(row.MAX_DURATION_MS),
    compensationFailureConfig: parseJson(row.COMPENSATION_FAILURE_CONFIG),
    version: num(row.VERSION) ?? 1,
    createdAt: str(row.CREATED_AT),
    updatedAt: str(row.UPDATED_AT),
  };
}

function toStep(row: Row): WorkflowStepRecord {
  return {
    id: str(row.ID),
    workflowId: str(row.WORKFLOW_ID),
    name: maybe(row.NAME),
    stepOrder: num(row.STEP_ORDER) ?? 0,
    stepGroup: num(row.STEP_GROUP) ?? 0,
    componentId: str(row.COMPONENT_ID),
    dependsOnStepId: maybe(row.DEPENDS_ON_STEP_ID),
    compensationService: maybe(row.COMPENSATION_SERVICE),
    compensationAction: maybe(row.COMPENSATION_ACTION),
    condition: maybe(row.CONDITION),
    onFailure: (maybe(row.ON_FAILURE) ?? 'halt') as WorkflowStepRecord['onFailure'],
    idempotencyKeyHeader: maybe(row.IDEMPOTENCY_KEY_HEADER),
    verifyAction: maybe(row.VERIFY_ACTION),
  };
}

function toExecution(row: Row): ExecutionRecord {
  const code = maybe(row.ERROR_CODE);
  return {
    executionId: str(row.EXECUTION_ID),
    type: str(row.TYPE) as ExecutionRecord['type'],
    refName: str(row.REF_NAME),
    service: maybe(row.SERVICE),
    action: maybe(row.ACTION),
    groupId: maybe(row.GROUP_ID),
    status: str(row.STATUS) as ExecutionRecord['status'],
    context: (parseJson<Record<string, unknown>>(row.CONTEXT) ?? {}) as Record<string, unknown>,
    steps: parseJson(row.STEPS),
    result: parseJson(row.RESULT) ?? null,
    maxDurationMs: num(row.MAX_DURATION_MS),
    error: code === undefined
      ? undefined
      : { code, message: maybe(row.ERROR_MESSAGE) ?? '', details: parseJson(row.ERROR_DETAILS) },
    attempts: num(row.ATTEMPTS) ?? 0,
    startedAt: str(row.STARTED_AT),
    completedAt: maybe(row.COMPLETED_AT),
    createdAt: str(row.CREATED_AT),
    updatedAt: str(row.UPDATED_AT),
  };
}

function toLog(row: Row): ExecutionLogRecord {
  return {
    id: str(row.ID),
    executionId: str(row.EXECUTION_ID),
    workflowName: maybe(row.WORKFLOW_NAME),
    service: maybe(row.SERVICE),
    action: maybe(row.ACTION),
    componentType: maybe(row.COMPONENT_TYPE),
    stepOrder: num(row.STEP_ORDER),
    status: str(row.STATUS) as ExecutionLogRecord['status'],
    requestData: maybe(row.REQUEST_DATA),
    responseData: maybe(row.RESPONSE_DATA),
    errorMessage: maybe(row.ERROR_MESSAGE),
    durationMs: num(row.DURATION_MS),
    createdAt: str(row.CREATED_AT),
  };
}

interface Lease {
  conn: Connection;
  /** Ends the lease: closes the pooled connection, or is a no-op inside a transaction. */
  done: () => Promise<void>;
}

type AdapterMethods = Omit<DBAdapter, 'type' | 'connect' | 'disconnect' | 'transaction'>;

/**
 * Oracle has no Drizzle dialect, so every statement is hand-written. The
 * executor is leased (pool) or borrowed (transaction) — same method table for
 * both, so behaviour cannot drift. Row limiting uses FETCH FIRST; JSON columns
 * are VARCHAR2 and are stringified/parsed here, in one place.
 */
function buildMethods(acquire: () => Promise<Lease>, autoCommit: boolean, dsn: string): AdapterMethods {
  const run = async <T>(work: (conn: Connection) => Promise<T>): Promise<T> => {
    const lease = await acquire();
    try {
      return await work(lease.conn);
    } catch (err) {
      throw translate(err, dsn);
    } finally {
      await lease.done();
    }
  };

  const query = async (conn: Connection, sql: string, binds: unknown[] = []): Promise<Row[]> => {
    const result = await conn.execute(sql, binds as never, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      autoCommit,
    });
    return (result.rows ?? []) as Row[];
  };

  const mutate = async (conn: Connection, sql: string, binds: unknown[] = []): Promise<number> => {
    const result = await conn.execute(sql, binds as never, { autoCommit });
    return result.rowsAffected ?? 0;
  };

  const now = () => new Date().toISOString();
  const page = (limit: number, offset: number) =>
    `OFFSET ${Math.max(0, Math.trunc(offset))} ROWS FETCH FIRST ${Math.max(1, Math.trunc(limit))} ROWS ONLY`;

  return {
    async saveComponent(comp) {
      return run(async (conn) => {
        await mutate(
          conn,
          `INSERT INTO component_definitions
             (id, service, action, component_type, description, config, condition, meta_data, version, created_at, updated_at)
           VALUES (:1, :2, :3, :4, :5, :6, :7, :8, 1, :9, :10)`,
          [
            comp.id,
            comp.service,
            comp.action,
            comp.componentType,
            comp.description ?? null,
            toJson(comp.config) ?? '{}',
            comp.condition ?? null,
            toJson(comp.metaData),
            comp.createdAt,
            comp.updatedAt,
          ]
        );
        const rows = await query(conn, 'SELECT * FROM component_definitions WHERE id = :1', [comp.id]);
        return toComponent(rows[0]);
      });
    },

    async getComponent(id) {
      return run(async (conn) => {
        const rows = await query(conn, 'SELECT * FROM component_definitions WHERE id = :1', [id]);
        return rows[0] ? toComponent(rows[0]) : null;
      });
    },

    async findComponent(service, action) {
      return run(async (conn) => {
        const rows = await query(
          conn,
          'SELECT * FROM component_definitions WHERE service = :1 AND action = :2',
          [service, action]
        );
        return rows[0] ? toComponent(rows[0]) : null;
      });
    },

    async listComponents(filters, limit = 50, offset = 0) {
      return run(async (conn) => {
        const binds: unknown[] = [];
        let where = '';
        if (filters?.service) {
          binds.push(filters.service);
          where += ` AND service = :${binds.length}`;
        }
        if (filters?.componentType) {
          binds.push(filters.componentType);
          where += ` AND component_type = :${binds.length}`;
        }
        const rows = await query(
          conn,
          `SELECT * FROM component_definitions WHERE 1 = 1${where}
           ORDER BY created_at, id ${page(limit, offset)}`,
          binds
        );
        return rows.map(toComponent);
      });
    },

    async countComponents(filters) {
      return run(async (conn) => {
        const binds: unknown[] = [];
        let where = '';
        if (filters?.service) {
          binds.push(filters.service);
          where += ` AND service = :${binds.length}`;
        }
        if (filters?.componentType) {
          binds.push(filters.componentType);
          where += ` AND component_type = :${binds.length}`;
        }
        const rows = await query(
          conn,
          `SELECT COUNT(*) AS CNT FROM component_definitions WHERE 1 = 1${where}`,
          binds
        );
        return num(rows[0]?.CNT) ?? 0;
      });
    },

    async updateComponent(id, changes) {
      return run(async (conn) => {
        const sets: string[] = [];
        const binds: unknown[] = [];
        const push = (column: string, value: unknown) => {
          binds.push(value);
          sets.push(`${column} = :${binds.length}`);
        };
        if ('service' in changes) push('service', changes.service);
        if ('action' in changes) push('action', changes.action);
        if ('componentType' in changes) push('component_type', changes.componentType);
        if ('description' in changes) push('description', changes.description ?? null);
        if ('config' in changes) push('config', toJson(changes.config));
        if ('condition' in changes) push('condition', changes.condition ?? null);
        if ('metaData' in changes) push('meta_data', toJson(changes.metaData));
        push('version', (changes.version ?? 0) + 1);
        push('updated_at', now());
        binds.push(id);

        const affected = await mutate(
          conn,
          `UPDATE component_definitions SET ${sets.join(', ')} WHERE id = :${binds.length}`,
          binds
        );
        if (affected === 0) throw new NotFoundError(`Component ${id} not found`);
        const rows = await query(conn, 'SELECT * FROM component_definitions WHERE id = :1', [id]);
        return toComponent(rows[0]);
      });
    },

    async deleteComponent(id) {
      return run(async (conn) => {
        const affected = await mutate(conn, 'DELETE FROM component_definitions WHERE id = :1', [id]);
        if (affected === 0) throw new NotFoundError(`Component ${id} not found`);
      });
    },

    async saveWorkflow(wf) {
      return run(async (conn) => {
        await mutate(
          conn,
          `INSERT INTO workflow_definitions
             (id, name, group_id, description, response_mapping, max_duration_ms,
              compensation_failure_config, version, created_at, updated_at)
           VALUES (:1, :2, :3, :4, :5, :6, :7, 1, :8, :9)`,
          [
            wf.id,
            wf.name,
            wf.groupId ?? null,
            wf.description ?? null,
            toJson(wf.responseMapping),
            wf.maxDurationMs ?? null,
            toJson(wf.compensationFailureConfig),
            wf.createdAt,
            wf.updatedAt,
          ]
        );
        const rows = await query(conn, 'SELECT * FROM workflow_definitions WHERE id = :1', [wf.id]);
        return toWorkflow(rows[0]);
      });
    },

    async getWorkflow(id) {
      return run(async (conn) => {
        const rows = await query(conn, 'SELECT * FROM workflow_definitions WHERE id = :1', [id]);
        return rows[0] ? toWorkflow(rows[0]) : null;
      });
    },

    async findWorkflowByName(name) {
      return run(async (conn) => {
        const rows = await query(conn, 'SELECT * FROM workflow_definitions WHERE name = :1', [name]);
        return rows[0] ? toWorkflow(rows[0]) : null;
      });
    },

    async listWorkflows(limit = 50, offset = 0) {
      return run(async (conn) => {
        const rows = await query(
          conn,
          `SELECT * FROM workflow_definitions ORDER BY created_at, id ${page(limit, offset)}`
        );
        return rows.map(toWorkflow);
      });
    },

    async updateWorkflow(id, changes) {
      return run(async (conn) => {
        const sets: string[] = [];
        const binds: unknown[] = [];
        const push = (column: string, value: unknown) => {
          binds.push(value);
          sets.push(`${column} = :${binds.length}`);
        };
        if (changes.name !== undefined) push('name', changes.name);
        if (changes.groupId !== undefined) push('group_id', changes.groupId);
        if (changes.description !== undefined) push('description', changes.description);
        if (changes.responseMapping !== undefined) push('response_mapping', toJson(changes.responseMapping));
        if (changes.maxDurationMs !== undefined) push('max_duration_ms', changes.maxDurationMs);
        if (changes.compensationFailureConfig !== undefined) {
          push('compensation_failure_config', toJson(changes.compensationFailureConfig));
        }
        push('version', (changes.version ?? 0) + 1);
        push('updated_at', now());
        binds.push(id);

        const affected = await mutate(
          conn,
          `UPDATE workflow_definitions SET ${sets.join(', ')} WHERE id = :${binds.length}`,
          binds
        );
        if (affected === 0) throw new NotFoundError(`Workflow ${id} not found`);
        const rows = await query(conn, 'SELECT * FROM workflow_definitions WHERE id = :1', [id]);
        return toWorkflow(rows[0]);
      });
    },

    async deleteWorkflow(id) {
      return run(async (conn) => {
        const affected = await mutate(conn, 'DELETE FROM workflow_definitions WHERE id = :1', [id]);
        if (affected === 0) throw new NotFoundError(`Workflow ${id} not found`);
      });
    },

    async saveWorkflowStep(step) {
      return run(async (conn) => {
        await mutate(
          conn,
          `INSERT INTO workflow_steps
             (id, workflow_id, name, step_order, step_group, component_id, depends_on_step_id,
              compensation_service, compensation_action, condition, on_failure,
              idempotency_key_header, verify_action)
           VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10, :11, :12, :13)`,
          [
            step.id,
            step.workflowId,
            step.name ?? null,
            step.stepOrder,
            step.stepGroup,
            step.componentId,
            step.dependsOnStepId ?? null,
            step.compensationService ?? null,
            step.compensationAction ?? null,
            step.condition ?? null,
            step.onFailure,
            step.idempotencyKeyHeader ?? null,
            step.verifyAction ?? null,
          ]
        );
        const rows = await query(conn, 'SELECT * FROM workflow_steps WHERE id = :1', [step.id]);
        return toStep(rows[0]);
      });
    },

    async getWorkflowSteps(workflowId) {
      return run(async (conn) => {
        const rows = await query(
          conn,
          'SELECT * FROM workflow_steps WHERE workflow_id = :1 ORDER BY step_order, id',
          [workflowId]
        );
        return rows.map(toStep);
      });
    },

    async deleteWorkflowSteps(workflowId) {
      return run(async (conn) => {
        await mutate(conn, 'DELETE FROM workflow_steps WHERE workflow_id = :1', [workflowId]);
      });
    },

    async saveExecution(record) {
      return run(async (conn) => {
        await mutate(
          conn,
          `INSERT INTO executions
             (execution_id, type, ref_name, service, action, group_id, status, context, steps, result,
              max_duration_ms, error_code, error_message, error_details, attempts,
              started_at, completed_at, created_at, updated_at)
           VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10, :11, :12, :13, :14, :15, :16, :17, :18, :19)`,
          [
            record.executionId,
            record.type,
            record.refName,
            record.service ?? null,
            record.action ?? null,
            record.groupId ?? null,
            record.status,
            toJson(record.context) ?? '{}',
            toJson(record.steps),
            toJson(record.result),
            record.maxDurationMs ?? null,
            record.error?.code ?? null,
            record.error?.message ?? null,
            toJson(record.error?.details),
            record.attempts ?? 0,
            record.startedAt,
            record.completedAt ?? null,
            record.createdAt,
            record.updatedAt,
          ]
        );
        const rows = await query(conn, 'SELECT * FROM executions WHERE execution_id = :1', [record.executionId]);
        return toExecution(rows[0]);
      });
    },

    async getExecution(executionId) {
      return run(async (conn) => {
        const rows = await query(conn, 'SELECT * FROM executions WHERE execution_id = :1', [executionId]);
        return rows[0] ? toExecution(rows[0]) : null;
      });
    },

    async saveExecutionLog(log) {
      return run(async (conn) => {
        await mutate(
          conn,
          `INSERT INTO execution_logs
             (id, execution_id, workflow_name, service, action, component_type, step_order, status,
              request_data, response_data, error_message, duration_ms, created_at)
           VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10, :11, :12, :13)`,
          [
            log.id,
            log.executionId,
            log.workflowName ?? null,
            log.service ?? null,
            log.action ?? null,
            log.componentType ?? null,
            log.stepOrder ?? null,
            log.status,
            log.requestData ?? null,
            log.responseData ?? null,
            log.errorMessage ?? null,
            log.durationMs ?? null,
            log.createdAt,
          ]
        );
        const rows = await query(conn, 'SELECT * FROM execution_logs WHERE id = :1', [log.id]);
        return toLog(rows[0]);
      });
    },

    async getExecutionLogs(executionId) {
      return run(async (conn) => {
        const rows = await query(
          conn,
          'SELECT * FROM execution_logs WHERE execution_id = :1 ORDER BY created_at, id',
          [executionId]
        );
        return rows.map(toLog);
      });
    },

    async getConfig(key) {
      return run(async (conn) => {
        const rows = await query(conn, 'SELECT value FROM master_configuration WHERE key = :1', [key]);
        return rows[0] ? str(rows[0].VALUE) : null;
      });
    },

    async setConfig(key, value, valueType) {
      return run(async (conn) => {
        const ts = now();
        await mutate(
          conn,
          `MERGE INTO master_configuration t
           USING (SELECT :1 AS key FROM dual) s
           ON (t.key = s.key)
           WHEN MATCHED THEN UPDATE SET t.value = :2, t.value_type = :3, t.updated_at = :4
           WHEN NOT MATCHED THEN INSERT (id, key, value, value_type, created_at, updated_at)
             VALUES (:5, :1, :2, :3, :4, :4)`,
          [key, value, valueType, ts, generateId()]
        );
      });
    },

    async deleteConfig(key) {
      return run(async (conn) => {
        const affected = await mutate(conn, 'DELETE FROM master_configuration WHERE key = :1', [key]);
        if (affected === 0) throw new NotFoundError(`Config ${key} not found`);
      });
    },
  };
}

async function probeSchema(pool: Pool, dsn: string): Promise<string[]> {
  const required = [...REQUIRED_TABLES, ...(auditEnabled() ? OPTIONAL_TABLES : [])];
  const missing: string[] = [];
  const connection = await pool.getConnection();
  try {
    const result = await connection.execute<Row>(
      'SELECT table_name AS NAME FROM user_tables WHERE table_name IN ('
      + required.map((_, i) => `:${i + 1}`).join(', ') + ')',
      required as never,
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const present = new Set(((result.rows ?? []) as Row[]).map((row) => str(row.NAME)));
    missing.push(...required.filter((table) => !present.has(table)));

    if (!missing.includes('COMPONENT_DEFINITIONS')) {
      const indexResult = await connection.execute<Row>(
        'SELECT index_name AS NAME FROM user_indexes WHERE index_name = :1',
        [UNIQUE_INDEX] as never,
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      if (((indexResult.rows ?? []) as Row[]).length === 0) {
        missing.push(`${UNIQUE_INDEX} (unique index on component_definitions)`);
      }
    }
  } catch (err) {
    throw translate(err, dsn);
  } finally {
    await connection.close();
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

function parseDsn(databaseUrl: string): { user: string; password: string; connectString: string } {
  const parsed = new URL(databaseUrl);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    connectString: `${parsed.hostname}:${parsed.port || '1521'}${parsed.pathname}`,
  };
}

export async function createOracleAdapter(databaseUrl: string): Promise<DBAdapter> {
  const credentials = parseDsn(databaseUrl);
  const pool = await oracledb.createPool({
    ...credentials,
    poolMin: 1,
    poolMax: 10,
    poolTimeout: 60,
  });
  const poolLease = async (): Promise<Lease> => {
    const conn = await pool.getConnection();
    return { conn, done: () => conn.close() };
  };
  const methods = buildMethods(poolLease, true, databaseUrl);

  return {
    type: 'oracle',
    ...methods,

    async connect(): Promise<void> {
      await probeSchema(pool, databaseUrl);
    },

    async disconnect(): Promise<void> {
      await pool.close(0);
    },

    async transaction<T>(fn: (tx: DBAdapter) => Promise<T>): Promise<T> {
      const conn = await pool.getConnection();
      const lease: Lease = { conn, done: async () => {} };
      try {
        const txMethods = buildMethods(async () => lease, false, databaseUrl);
        const txAdapter: DBAdapter = {
          type: 'oracle',
          ...txMethods,
          async connect(): Promise<void> {},
          async disconnect(): Promise<void> {},
          async transaction<R>(): Promise<R> {
            throw new UnsupportedOperationError('Nested transactions are not supported');
          },
        };
        const result = await fn(txAdapter);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback();
        throw translate(err, databaseUrl);
      } finally {
        await conn.close();
      }
    },
  };
}
