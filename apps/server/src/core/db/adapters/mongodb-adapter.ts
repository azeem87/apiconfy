import {
  MongoClient,
  MongoNetworkError,
  MongoServerSelectionError,
} from 'mongodb';
import type { ClientSession, Db, Document, IndexDescription } from 'mongodb';
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

const REQUIRED_COLLECTIONS = [
  'component_definitions',
  'workflow_definitions',
  'workflow_steps',
  'executions',
  'master_configuration',
];
const OPTIONAL_COLLECTIONS = ['execution_logs'];
const SCHEMA_FILE = 'apps/server/src/core/db/schema/mongodb/mongodb.js';
const SCHEMA_URL = 'https://github.com/apiconfy/apiconfy/blob/main/apps/server/src/core/db/schema/mongodb/mongodb.js';
const SCHEMA_COMMAND = `mongosh "<DATABASE_URL>" ${SCHEMA_FILE}`;

/** Field-level uniqueness is enforced by the operator's unique indexes. */
const REQUIRED_UNIQUE_INDEXES: Record<string, Document> = {
  component_definitions: { service: 1, action: 1 },
  workflow_definitions: { name: 1 },
  master_configuration: { key: 1 },
};

const PROJECTION = { projection: { _id: 0 } } as const;

function auditEnabled(): boolean {
  return process.env.ENABLE_DB_TRANSACTION_LOGS === 'true';
}

function redact(dsn: string): string {
  return dsn.replace(/\/\/[^@/]*@/, '//***@');
}

function translate(err: unknown, dsn: string): AppError {
  if (err instanceof AppError) return err;
  const { code, message = 'MongoDB error' } = (err ?? {}) as { code?: number | string; message?: string };
  if (code === 11000) return new ConflictError(message);
  if (
    err instanceof MongoNetworkError
    || err instanceof MongoServerSelectionError
    || code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT'
  ) {
    return new ConnectionError(`MongoDB unavailable at ${redact(dsn)}: ${message}`);
  }
  return new DatabaseError(message);
}

const absent = (doc: Document | null | undefined): boolean => !doc;

function toComponent(doc: Document): ComponentRecord {
  return {
    id: doc.id as string,
    service: doc.service as string,
    action: doc.action as string,
    componentType: doc.componentType as string,
    description: doc.description ?? undefined,
    config: (doc.config ?? {}) as Record<string, unknown>,
    condition: doc.condition ?? undefined,
    metaData: doc.metaData ?? undefined,
    version: (doc.version as number) ?? 1,
    createdAt: doc.createdAt as string,
    updatedAt: doc.updatedAt as string,
  };
}

function toWorkflow(doc: Document): WorkflowRecord {
  return {
    id: doc.id as string,
    name: doc.name as string,
    groupId: doc.groupId ?? undefined,
    description: doc.description ?? undefined,
    responseMapping: doc.responseMapping ?? undefined,
    maxDurationMs: doc.maxDurationMs ?? undefined,
    compensationFailureConfig: doc.compensationFailureConfig ?? undefined,
    version: (doc.version as number) ?? 1,
    createdAt: doc.createdAt as string,
    updatedAt: doc.updatedAt as string,
  };
}

function toStep(doc: Document): WorkflowStepRecord {
  return {
    id: doc.id as string,
    workflowId: doc.workflowId as string,
    name: doc.name ?? undefined,
    stepOrder: doc.stepOrder as number,
    stepGroup: (doc.stepGroup as number) ?? 0,
    componentId: doc.componentId as string,
    dependsOnStepId: doc.dependsOnStepId ?? undefined,
    compensationService: doc.compensationService ?? undefined,
    compensationAction: doc.compensationAction ?? undefined,
    condition: doc.condition ?? undefined,
    onFailure: (doc.onFailure as WorkflowStepRecord['onFailure']) ?? 'halt',
    idempotencyKeyHeader: doc.idempotencyKeyHeader ?? undefined,
    verifyAction: doc.verifyAction ?? undefined,
  };
}

function toExecution(doc: Document): ExecutionRecord {
  return {
    executionId: doc.executionId as string,
    type: doc.type as ExecutionRecord['type'],
    refName: doc.refName as string,
    service: doc.service ?? undefined,
    action: doc.action ?? undefined,
    groupId: doc.groupId ?? undefined,
    status: doc.status as ExecutionRecord['status'],
    context: (doc.context ?? {}) as Record<string, unknown>,
    steps: doc.steps ?? undefined,
    result: doc.result ?? null,
    maxDurationMs: doc.maxDurationMs ?? undefined,
    error: doc.error ?? undefined,
    attempts: (doc.attempts as number) ?? 0,
    startedAt: doc.startedAt as string,
    completedAt: doc.completedAt ?? undefined,
    createdAt: doc.createdAt as string,
    updatedAt: doc.updatedAt as string,
  };
}

function toLog(doc: Document): ExecutionLogRecord {
  return {
    id: doc.id as string,
    executionId: doc.executionId as string,
    workflowName: doc.workflowName ?? undefined,
    service: doc.service ?? undefined,
    action: doc.action ?? undefined,
    componentType: doc.componentType ?? undefined,
    stepOrder: doc.stepOrder ?? undefined,
    status: doc.status as ExecutionLogRecord['status'],
    requestData: doc.requestData ?? undefined,
    responseData: doc.responseData ?? undefined,
    errorMessage: doc.errorMessage ?? undefined,
    durationMs: doc.durationMs ?? undefined,
    createdAt: doc.createdAt as string,
  };
}

type AdapterMethods = Omit<DBAdapter, 'type' | 'connect' | 'disconnect' | 'transaction'>;

/**
 * Collections are documents, so the methods map records straight to BSON; the
 * executor is the client or a transaction session (same table for both). Relational
 * behaviour the database cannot give us — the FK cascade and the referenced-delete
 * guard — lives here in application code, as agreed for NoSQL.
 */
function buildMethods(getDb: () => Db, getSession: () => ClientSession | undefined, dsn: string): AdapterMethods {
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw translate(err, dsn);
    }
  };
  const now = () => new Date().toISOString();
  const opts = () => ({ session: getSession() });

  const componentDefinitions = () => getDb().collection('component_definitions');
  const workflowDefinitions = () => getDb().collection('workflow_definitions');
  const workflowSteps = () => getDb().collection('workflow_steps');
  const executions = () => getDb().collection('executions');
  const executionLogs = () => getDb().collection('execution_logs');
  const masterConfiguration = () => getDb().collection('master_configuration');

  return {
    async saveComponent(comp) {
      return guard(async () => {
        await componentDefinitions().insertOne({ ...comp }, opts());
        const doc = await componentDefinitions().findOne({ id: comp.id }, { ...PROJECTION, ...opts() });
        return toComponent(doc as Document);
      });
    },

    async getComponent(id) {
      return guard(async () => {
        const doc = await componentDefinitions().findOne({ id }, { ...PROJECTION, ...opts() });
        return absent(doc) ? null : toComponent(doc as Document);
      });
    },

    async findComponent(service, action) {
      return guard(async () => {
        const doc = await componentDefinitions().findOne({ service, action }, { ...PROJECTION, ...opts() });
        return absent(doc) ? null : toComponent(doc as Document);
      });
    },

    async listComponents(filters?: ComponentFilters, limit = 50, offset = 0) {
      return guard(async () => {
        const query: Document = {};
        if (filters?.service) query.service = filters.service;
        if (filters?.componentType) query.componentType = filters.componentType;
        const docs = await componentDefinitions()
          .find(query, { ...PROJECTION, ...opts() })
          .sort({ createdAt: 1, id: 1 })
          .skip(Math.max(0, offset))
          .limit(Math.max(1, limit))
          .toArray();
        return docs.map(toComponent);
      });
    },

    async countComponents(filters?: ComponentFilters) {
      return guard(async () => {
        const query: Document = {};
        if (filters?.service) query.service = filters.service;
        if (filters?.componentType) query.componentType = filters.componentType;
        return componentDefinitions().countDocuments(query, opts());
      });
    },

    async updateComponent(id, changes) {
      return guard(async () => {
        const set: Document = { updatedAt: now(), version: (changes.version ?? 0) + 1 };
        if ('service' in changes) set.service = changes.service;
        if ('action' in changes) set.action = changes.action;
        if ('componentType' in changes) set.componentType = changes.componentType;
        if ('description' in changes) set.description = changes.description ?? null;
        if ('config' in changes) set.config = changes.config;
        if ('condition' in changes) set.condition = changes.condition ?? null;
        if ('metaData' in changes) set.metaData = changes.metaData ?? null;

        const doc = await componentDefinitions().findOneAndUpdate(
          { id },
          { $set: set },
          { returnDocument: 'after', ...PROJECTION, ...opts() }
        );
        if (absent(doc)) throw new NotFoundError(`Component ${id} not found`);
        return toComponent(doc as Document);
      });
    },

    async deleteComponent(id) {
      return guard(async () => {
        const referencing = await workflowSteps().countDocuments({ componentId: id }, opts());
        if (referencing > 0) {
          throw new ConflictError(`Component ${id} is referenced by ${referencing} workflow step(s)`);
        }
        const result = await componentDefinitions().deleteOne({ id }, opts());
        if (result.deletedCount === 0) throw new NotFoundError(`Component ${id} not found`);
      });
    },

    async saveWorkflow(wf) {
      return guard(async () => {
        await workflowDefinitions().insertOne({ ...wf }, opts());
        const doc = await workflowDefinitions().findOne({ id: wf.id }, { ...PROJECTION, ...opts() });
        return toWorkflow(doc as Document);
      });
    },

    async getWorkflow(id) {
      return guard(async () => {
        const doc = await workflowDefinitions().findOne({ id }, { ...PROJECTION, ...opts() });
        return absent(doc) ? null : toWorkflow(doc as Document);
      });
    },

    async findWorkflowByName(name) {
      return guard(async () => {
        const doc = await workflowDefinitions().findOne({ name }, { ...PROJECTION, ...opts() });
        return absent(doc) ? null : toWorkflow(doc as Document);
      });
    },

    async listWorkflows(limit = 50, offset = 0) {
      return guard(async () => {
        const docs = await workflowDefinitions()
          .find({}, { ...PROJECTION, ...opts() })
          .sort({ createdAt: 1, id: 1 })
          .skip(Math.max(0, offset))
          .limit(Math.max(1, limit))
          .toArray();
        return docs.map(toWorkflow);
      });
    },

    async updateWorkflow(id, changes) {
      return guard(async () => {
        const set: Document = { updatedAt: now(), version: (changes.version ?? 0) + 1 };
        if (changes.name !== undefined) set.name = changes.name;
        if (changes.groupId !== undefined) set.groupId = changes.groupId;
        if (changes.description !== undefined) set.description = changes.description;
        if (changes.responseMapping !== undefined) set.responseMapping = changes.responseMapping;
        if (changes.maxDurationMs !== undefined) set.maxDurationMs = changes.maxDurationMs;
        if (changes.compensationFailureConfig !== undefined) {
          set.compensationFailureConfig = changes.compensationFailureConfig;
        }

        const doc = await workflowDefinitions().findOneAndUpdate(
          { id },
          { $set: set },
          { returnDocument: 'after', ...PROJECTION, ...opts() }
        );
        if (absent(doc)) throw new NotFoundError(`Workflow ${id} not found`);
        return toWorkflow(doc as Document);
      });
    },

    async deleteWorkflow(id) {
      return guard(async () => {
        await workflowSteps().deleteMany({ workflowId: id }, opts());
        const result = await workflowDefinitions().deleteOne({ id }, opts());
        if (result.deletedCount === 0) throw new NotFoundError(`Workflow ${id} not found`);
      });
    },

    async saveWorkflowStep(step) {
      return guard(async () => {
        // No foreign keys here: a step referencing a missing component must fail the way the
        // SQL engines fail (FK violation → ConflictError), or a transaction would commit a
        // workflow whose steps point at nothing.
        const existing = await componentDefinitions().countDocuments({ id: step.componentId }, opts());
        if (existing === 0) {
          throw new ConflictError(`Component ${step.componentId} does not exist`);
        }
        await workflowSteps().insertOne({ ...step }, opts());
        const doc = await workflowSteps().findOne({ id: step.id }, { ...PROJECTION, ...opts() });
        return toStep(doc as Document);
      });
    },

    async getWorkflowSteps(workflowId) {
      return guard(async () => {
        const docs = await workflowSteps()
          .find({ workflowId }, { ...PROJECTION, ...opts() })
          .sort({ stepOrder: 1, id: 1 })
          .toArray();
        return docs.map(toStep);
      });
    },

    async deleteWorkflowSteps(workflowId) {
      return guard(async () => {
        await workflowSteps().deleteMany({ workflowId }, opts());
      });
    },

    async saveExecution(record) {
      return guard(async () => {
        await executions().insertOne({ ...record, attempts: record.attempts ?? 0 }, opts());
        const doc = await executions().findOne({ executionId: record.executionId }, { ...PROJECTION, ...opts() });
        return toExecution(doc as Document);
      });
    },

    async getExecution(executionId) {
      return guard(async () => {
        const doc = await executions().findOne({ executionId }, { ...PROJECTION, ...opts() });
        return absent(doc) ? null : toExecution(doc as Document);
      });
    },

    async saveExecutionLog(log) {
      return guard(async () => {
        await executionLogs().insertOne({ ...log }, opts());
        const doc = await executionLogs().findOne({ id: log.id }, { ...PROJECTION, ...opts() });
        return toLog(doc as Document);
      });
    },

    async getExecutionLogs(executionId) {
      return guard(async () => {
        const docs = await executionLogs()
          .find({ executionId }, { ...PROJECTION, ...opts() })
          .sort({ createdAt: 1, id: 1 })
          .toArray();
        return docs.map(toLog);
      });
    },

    async getConfig(key) {
      return guard(async () => {
        const doc = await masterConfiguration().findOne({ key }, { ...PROJECTION, ...opts() });
        return absent(doc) ? null : (doc as Document).value as string;
      });
    },

    async setConfig(key, value, valueType) {
      return guard(async () => {
        const ts = now();
        await masterConfiguration().updateOne(
          { key },
          { $set: { value, valueType, updatedAt: ts }, $setOnInsert: { key, createdAt: ts } },
          { upsert: true, ...opts() }
        );
      });
    },

    async deleteConfig(key) {
      return guard(async () => {
        const result = await masterConfiguration().deleteOne({ key }, opts());
        if (result.deletedCount === 0) throw new NotFoundError(`Config ${key} not found`);
      });
    },
  };
}

async function probeSchema(db: Db, dsn: string): Promise<string[]> {
  const required = [...REQUIRED_COLLECTIONS, ...(auditEnabled() ? OPTIONAL_COLLECTIONS : [])];
  const missing: string[] = [];

  try {
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    const present = new Set(collections.map((entry) => entry.name));
    missing.push(...required.filter((collection) => !present.has(collection)));

    for (const [collection, keys] of Object.entries(REQUIRED_UNIQUE_INDEXES)) {
      if (!present.has(collection)) continue;
      const indexes: IndexDescription[] = await db.collection(collection).listIndexes().toArray();
      const hasUnique = indexes.some(
        (index) => index.unique === true && JSON.stringify(index.key) === JSON.stringify(keys)
      );
      if (!hasUnique) missing.push(`${collection} unique index ${JSON.stringify(keys)}`);
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

export async function createMongoDbAdapter(databaseUrl: string): Promise<DBAdapter> {
  const client = new MongoClient(databaseUrl, { maxPoolSize: 10, serverSelectionTimeoutMS: 10_000 });
  let db: Db;
  let transactionsSupported = false;

  return {
    type: 'mongodb' as const,
    ...buildMethods(() => db, () => undefined, databaseUrl),

    async connect(): Promise<void> {
      try {
        await client.connect();
        db = client.db(new URL(databaseUrl).pathname.replace(/^\//, '') || 'apiconfy');
        const hello = (await db.admin().command({ hello: 1 })) as Document;
        transactionsSupported = Boolean(hello.setName) || hello.msg === 'isdbgrid';
      } catch (err) {
        throw translate(err, databaseUrl);
      }
      await probeSchema(db, databaseUrl);
    },

    async disconnect(): Promise<void> {
      await client.close();
    },

    async transaction<T>(fn: (tx: DBAdapter) => Promise<T>): Promise<T> {
      if (!transactionsSupported) {
        throw new UnsupportedOperationError(
          'This MongoDB deployment does not support transactions (standalone server) — '
          + 'use a replica set, or run without transaction-backed writes'
        );
      }
      const session = client.startSession();
      try {
        let outcome: T | undefined;
        await session.withTransaction(async () => {
          const txAdapter: DBAdapter = {
            type: 'mongodb',
            ...buildMethods(() => db, () => session, databaseUrl),
            async connect(): Promise<void> {},
            async disconnect(): Promise<void> {},
            async transaction<R>(): Promise<R> {
              throw new UnsupportedOperationError('Nested transactions are not supported');
            },
          };
          outcome = await fn(txAdapter);
        });
        return outcome as T;
      } catch (err) {
        throw translate(err, databaseUrl);
      } finally {
        await session.endSession();
      }
    },
  };
}

/** Collections the adapter reads; exported for the index script and tests. */
export const MONGODB_COLLECTIONS = REQUIRED_COLLECTIONS;
