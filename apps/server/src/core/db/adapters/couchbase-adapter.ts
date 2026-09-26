import {
  AmbiguousTimeoutError,
  BucketNotFoundError,
  DocumentExistsError,
  DocumentNotFoundError,
  UnambiguousTimeoutError,
  connect,
} from 'couchbase';
import type { Bucket, Cluster, Scope } from 'couchbase';
import {
  AppError,
  ConflictError,
  ConnectionError,
  DatabaseError,
  NotFoundError,
  UnsupportedOperationError,
} from '@/lib/errors.js';
import type {
  ComponentFilters,
  ComponentRecord,
  DBAdapter,
  ExecutionLogRecord,
  ExecutionRecord,
  WorkflowRecord,
  WorkflowStepRecord,
} from '../adapter.js';

const COLLECTIONS = [
  'component_definitions',
  'workflow_definitions',
  'workflow_steps',
  'executions',
  'master_configuration',
];
const OPTIONAL_COLLECTIONS = ['execution_logs'];
const SCHEMA_FILE = 'apps/server/src/core/db/schema/couchbase/couchbase.js';
const SCHEMA_URL = 'https://github.com/apiconfy/apiconfy/blob/main/apps/server/src/core/db/schema/couchbase/couchbase.js';
const SCHEMA_COMMAND = `CB_BUCKET=apiconfy bun run ${SCHEMA_FILE}`;

function auditEnabled(): boolean {
  return process.env.ENABLE_DB_TRANSACTION_LOGS === 'true';
}

function translate(err: unknown, dsn: string): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof DocumentNotFoundError) return new NotFoundError(err.message);
  if (err instanceof DocumentExistsError) return new ConflictError(err.message);
  if (
    err instanceof UnambiguousTimeoutError
    || err instanceof AmbiguousTimeoutError
    || err instanceof BucketNotFoundError
  ) {
    return new ConnectionError(`Couchbase unavailable at ${dsn.replace(/\/\/[^@/]*@/, '//***@')}: ${err.message}`);
  }
  const { code, message = 'Couchbase error' } = (err ?? {}) as { code?: number; message?: string };
  if (code === 4000) {
    return new DatabaseError(
      `${message}\nThe operator's index script creates the primary index (${SCHEMA_FILE}).`
    );
  }
  return new DatabaseError(message);
}

/** Decision #6: the natural key *is* the document key — uniqueness for free. */
const enc = encodeURIComponent;
const componentKey = (service: string, action: string) => `component::${enc(service)}::${enc(action)}`;
const workflowKey = (name: string) => `wf::${enc(name)}`;
const stepKey = (id: string) => `step::${enc(id)}`;
const executionKey = (id: string) => `exec::${enc(id)}`;
const logKey = (id: string) => `log::${enc(id)}`;
const configKey = (key: string) => `cfg::${enc(key)}`;

interface Kv {
  get(key: string): Promise<{ content: unknown }>;
  insert(key: string, value: unknown): Promise<unknown>;
  replace(key: string, value: unknown): Promise<unknown>;
  upsert(key: string, value: unknown): Promise<unknown>;
  remove(key: string): Promise<unknown>;
}

type QueryRow = Record<string, unknown>;
type QueryFn = (statement: string, params: Record<string, unknown>) => Promise<QueryRow[]>;

type AdapterMethods = Omit<DBAdapter, 'type' | 'connect' | 'disconnect' | 'transaction'>;

const keyspace = (bucket: string, scope: string, collection: string) =>
  `\`${bucket}\`.\`${scope}\`.\`${collection}\``;

/**
 * Couchbase keeps decision #6's layout: KV for anything reachable by the natural
 * key, N1QL for by-id and filtered reads (the operator's secondary indexes make
 * those possible). Relational checks the database cannot do live here.
 */
function buildMethods(
  kv: (collection: string) => Kv,
  query: QueryFn,
  bucket: string,
  scope: string,
  dsn: string
): AdapterMethods {
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw translate(err, dsn);
    }
  };
  const now = () => new Date().toISOString();
  const from = (collection: string) => keyspace(bucket, scope, collection);
  const selectOne = async (collection: string, where: string, params: Record<string, unknown>) => {
    const rows = await query(`SELECT c.* FROM ${from(collection)} c WHERE ${where} LIMIT 1`, params);
    return rows[0];
  };

  const requireComponentKey = async (id: string): Promise<string> => {
    const row = await selectOne('component_definitions', 'c.id = $id', { id });
    if (row === undefined) throw new NotFoundError(`Component ${id} not found`);
    return componentKey(row.service as string, row.action as string);
  };

  const requireWorkflowKey = async (id: string): Promise<string> => {
    const row = await selectOne('workflow_definitions', 'c.id = $id', { id });
    if (row === undefined) throw new NotFoundError(`Workflow ${id} not found`);
    return workflowKey(row.name as string);
  };

  return {
    async saveComponent(comp) {
      return guard(async () => {
        await kv('component_definitions').insert(componentKey(comp.service, comp.action), { ...comp });
        return comp;
      });
    },

    async getComponent(id) {
      return guard(async () => {
        const row = await selectOne('component_definitions', 'c.id = $id', { id });
        return row ? (row as unknown as ComponentRecord) : null;
      });
    },

    async findComponent(service, action) {
      return guard(async () => {
        try {
          const result = await kv('component_definitions').get(componentKey(service, action));
          return result.content as ComponentRecord;
        } catch (err) {
          if (err instanceof DocumentNotFoundError) return null;
          throw err;
        }
      });
    },

    async listComponents(filters?: ComponentFilters, limit = 50, offset = 0) {
      return guard(async () => {
        const clauses: string[] = [];
        const params: Record<string, unknown> = { limit, offset };
        if (filters?.service) {
          clauses.push('c.service = $service');
          params.service = filters.service;
        }
        if (filters?.componentType) {
          clauses.push('c.componentType = $componentType');
          params.componentType = filters.componentType;
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = await query(
          `SELECT c.* FROM ${from('component_definitions')} c ${where} ORDER BY c.createdAt, c.id LIMIT $limit OFFSET $offset`,
          params
        );
        return rows as unknown as ComponentRecord[];
      });
    },

    async countComponents(filters?: ComponentFilters) {
      return guard(async () => {
        const clauses: string[] = [];
        const params: Record<string, unknown> = {};
        if (filters?.service) {
          clauses.push('c.service = $service');
          params.service = filters.service;
        }
        if (filters?.componentType) {
          clauses.push('c.componentType = $componentType');
          params.componentType = filters.componentType;
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = await query(
          `SELECT RAW COUNT(*) FROM ${from('component_definitions')} c ${where}`,
          params
        );
        return Number(rows[0] ?? 0);
      });
    },

    async updateComponent(id, changes) {
      return guard(async () => {
        const key = await requireComponentKey(id);
        const current = (await kv('component_definitions').get(key)).content as ComponentRecord;
        const allowed: Partial<ComponentRecord> = {};
        if ('componentType' in changes) allowed.componentType = changes.componentType;
        if ('description' in changes) allowed.description = changes.description;
        if ('config' in changes) allowed.config = changes.config;
        if ('condition' in changes) allowed.condition = changes.condition;
        if ('metaData' in changes) allowed.metaData = changes.metaData;
        const updated: ComponentRecord = {
          ...current,
          ...allowed,
          version: (changes.version ?? 0) + 1,
          updatedAt: now(),
        };
        await kv('component_definitions').replace(key, updated);
        return updated;
      });
    },

    async deleteComponent(id) {
      return guard(async () => {
        const key = await requireComponentKey(id);
        const rows = await query(
          `SELECT RAW COUNT(*) FROM ${from('workflow_steps')} s WHERE s.componentId = $id`,
          { id }
        );
        if (Number(rows[0] ?? 0) > 0) {
          throw new ConflictError(`Component ${id} is referenced by workflow step(s)`);
        }
        await kv('component_definitions').remove(key);
      });
    },

    async saveWorkflow(wf) {
      return guard(async () => {
        await kv('workflow_definitions').insert(workflowKey(wf.name), { ...wf });
        return wf;
      });
    },

    async getWorkflow(id) {
      return guard(async () => {
        const row = await selectOne('workflow_definitions', 'c.id = $id', { id });
        return row ? (row as unknown as WorkflowRecord) : null;
      });
    },

    async findWorkflowByName(name) {
      return guard(async () => {
        try {
          const result = await kv('workflow_definitions').get(workflowKey(name));
          return result.content as WorkflowRecord;
        } catch (err) {
          if (err instanceof DocumentNotFoundError) return null;
          throw err;
        }
      });
    },

    async listWorkflows(limit = 50, offset = 0) {
      return guard(async () => {
        const rows = await query(
          `SELECT c.* FROM ${from('workflow_definitions')} c ORDER BY c.createdAt, c.id LIMIT $limit OFFSET $offset`,
          { limit, offset }
        );
        return rows as unknown as WorkflowRecord[];
      });
    },

    async updateWorkflow(id, changes) {
      return guard(async () => {
        const key = await requireWorkflowKey(id);
        const current = (await kv('workflow_definitions').get(key)).content as WorkflowRecord;
        const allowed: Partial<WorkflowRecord> = {};
        if (changes.groupId !== undefined) allowed.groupId = changes.groupId;
        if (changes.description !== undefined) allowed.description = changes.description;
        if (changes.responseMapping !== undefined) allowed.responseMapping = changes.responseMapping;
        if (changes.maxDurationMs !== undefined) allowed.maxDurationMs = changes.maxDurationMs;
        if (changes.compensationFailureConfig !== undefined) {
          allowed.compensationFailureConfig = changes.compensationFailureConfig;
        }
        const updated: WorkflowRecord = {
          ...current,
          ...allowed,
          version: (changes.version ?? 0) + 1,
          updatedAt: now(),
        };
        await kv('workflow_definitions').replace(key, updated);
        return updated;
      });
    },

    async deleteWorkflow(id) {
      return guard(async () => {
        const key = await requireWorkflowKey(id);
        const stepIds = await query(
          `SELECT RAW s.id FROM ${from('workflow_steps')} s WHERE s.workflowId = $id`,
          { id }
        );
        for (const stepId of stepIds) {
          await kv('workflow_steps').remove(stepKey(String(stepId)));
        }
        await kv('workflow_definitions').remove(key);
      });
    },

    async saveWorkflowStep(step) {
      return guard(async () => {
        const rows = await query(
          `SELECT RAW COUNT(*) FROM ${from('component_definitions')} c WHERE c.id = $id`,
          { id: step.componentId }
        );
        if (Number(rows[0] ?? 0) === 0) {
          throw new ConflictError(`Component ${step.componentId} does not exist`);
        }
        await kv('workflow_steps').insert(stepKey(step.id), { ...step });
        return step;
      });
    },

    async getWorkflowSteps(workflowId) {
      return guard(async () => {
        const rows = await query(
          `SELECT c.* FROM ${from('workflow_steps')} c WHERE c.workflowId = $workflowId ORDER BY c.stepOrder, c.id`,
          { workflowId }
        );
        return rows as unknown as WorkflowStepRecord[];
      });
    },

    async deleteWorkflowSteps(workflowId) {
      return guard(async () => {
        const stepIds = await query(
          `SELECT RAW s.id FROM ${from('workflow_steps')} s WHERE s.workflowId = $workflowId`,
          { workflowId }
        );
        for (const stepId of stepIds) {
          await kv('workflow_steps').remove(stepKey(String(stepId)));
        }
      });
    },

    async saveExecution(record) {
      return guard(async () => {
        const stored = { ...record, attempts: record.attempts ?? 0 };
        await kv('executions').insert(executionKey(record.executionId), stored);
        return stored as ExecutionRecord;
      });
    },

    async getExecution(executionId) {
      return guard(async () => {
        try {
          const result = await kv('executions').get(executionKey(executionId));
          return result.content as ExecutionRecord;
        } catch (err) {
          if (err instanceof DocumentNotFoundError) return null;
          throw err;
        }
      });
    },

    async saveExecutionLog(log) {
      return guard(async () => {
        await kv('execution_logs').insert(logKey(log.id), { ...log });
        return log;
      });
    },

    async getExecutionLogs(executionId) {
      return guard(async () => {
        const rows = await query(
          `SELECT c.* FROM ${from('execution_logs')} c WHERE c.executionId = $executionId ORDER BY c.createdAt, c.id`,
          { executionId }
        );
        return rows as unknown as ExecutionLogRecord[];
      });
    },

    async getConfig(key) {
      return guard(async () => {
        try {
          const result = await kv('master_configuration').get(configKey(key));
          return (result.content as { value: string }).value;
        } catch (err) {
          if (err instanceof DocumentNotFoundError) return null;
          throw err;
        }
      });
    },

    async setConfig(key, value, valueType) {
      return guard(async () => {
        const ts = now();
        // Deliberate exception to insert-not-upsert: overwriting is the point.
        await kv('master_configuration').upsert(configKey(key), {
          id: configKey(key),
          key,
          value,
          valueType,
          createdAt: ts,
          updatedAt: ts,
        });
      });
    },

    async deleteConfig(key) {
      return guard(async () => {
        await kv('master_configuration').remove(configKey(key));
      });
    },
  };
}

async function probeSchema(
  cluster: Cluster,
  bucketName: string,
  scopeName: string,
  dsn: string
): Promise<string[]> {
  const required = [...COLLECTIONS, ...(auditEnabled() ? OPTIONAL_COLLECTIONS : [])];
  const missing: string[] = [];

  let bucket: Bucket;
  try {
    bucket = cluster.bucket(bucketName);
    const scopes = await bucket.collections().getAllScopes();
    const scope = scopes.find((entry) => entry.name === scopeName);
    const present = new Set((scope?.collections ?? []).map((entry) => entry.name));
    missing.push(...required.filter((collection) => !present.has(collection)));

    const indexRows = await cluster.query(
      'SELECT keyspace_id AS id, name FROM system:indexes WHERE bucket_id = $bucket AND scope_id = $scope',
      { parameters: { bucket: bucketName, scope: scopeName } }
    );
    const indexed = new Set(
      (indexRows.rows as QueryRow[])
        .filter((row) => row.name === '#primary')
        .map((row) => String(row.id))
    );
    for (const collection of required) {
      if (present.has(collection) && !indexed.has(collection)) {
        missing.push(`${collection} primary index`);
      }
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

export async function createCouchbaseAdapter(databaseUrl: string): Promise<DBAdapter> {
  const bucketName = process.env.CB_BUCKET ?? '';
  if (bucketName === '') {
    throw new DatabaseError('CB_BUCKET is required for the Couchbase adapter');
  }
  const scopeName = process.env.CB_SCOPE ?? '_default';
  const url = new URL(databaseUrl);
  // The documented form is `couchbase://host` with credentials in the environment, so accept
  // both: credentials in the URL win, otherwise CB_USER / CB_PASS.
  const username = decodeURIComponent(url.username) || process.env.CB_USER || 'Administrator';
  const password = decodeURIComponent(url.password) || process.env.CB_PASS || '';
  if (password === '') {
    throw new DatabaseError(
      'Couchbase credentials are missing — put them in DATABASE_URL or set CB_USER / CB_PASS'
    );
  }

  const cluster = await connect(`couchbase://${url.hostname}`, { username, password });
  let bucket: Bucket;
  let scope: Scope;

  const collectionKv = (name: string): Kv => scope.collection(name);
  const clusterQuery: QueryFn = async (statement, params) => {
    const result = await cluster.query(statement, { parameters: params });
    return result.rows as QueryRow[];
  };
  const methods = buildMethods(collectionKv, clusterQuery, bucketName, scopeName, databaseUrl);

  return {
    type: 'couchbase',
    ...methods,

    async connect(): Promise<void> {
      await probeSchema(cluster, bucketName, scopeName, databaseUrl);
      bucket = cluster.bucket(bucketName);
      scope = bucket.scope(scopeName);
    },

    async disconnect(): Promise<void> {
      await cluster.close();
    },

    /**
     * Decision #7: Couchbase's transactions API works on get-result handles
     * (get → replace/remove), not the plain KV shape this method table uses.
     * Rather than fake atomicity, transaction() refuses until a tx-aware
     * method table is built — see the Step 7 dialect notes in the plan.
     */
    async transaction<T>(): Promise<T> {
      throw new UnsupportedOperationError(
        'Couchbase transactions are not implemented in this slice — '
        + 'the transactional API needs a get-result based method table'
      );
    },
  };
}
