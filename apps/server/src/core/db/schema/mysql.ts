import { mysqlTable, varchar, text, int, json, uniqueIndex } from 'drizzle-orm/mysql-core';
import type { CompensationFailureConfig, OnFailureMode } from '../adapter.js';
import type { ExecutionStatus, ExecutionStep } from '@/core/types.js';

// MySQL-family keys and indexed columns must be VARCHAR — TEXT cannot be a
// primary key or take part in an index without a prefix length.
export const componentDefinitions = mysqlTable('component_definitions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  service: varchar('service', { length: 128 }).notNull(),
  action: varchar('action', { length: 128 }).notNull(),
  componentType: varchar('component_type', { length: 32 }).notNull(),
  description: text('description'),
  config: json('config').notNull().$type<Record<string, unknown>>(),
  condition: text('condition'),
  metaData: json('meta_data').$type<Record<string, unknown>>(),
  version: int('version').notNull().default(1),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
}, (table) => ({
  naturalKeyIdx: uniqueIndex('natural_key_idx').on(table.service, table.action),
}));

export const workflowDefinitions = mysqlTable('workflow_definitions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 191 }).notNull().unique(),
  groupId: varchar('group_id', { length: 64 }),
  description: text('description'),
  responseMapping: json('response_mapping').$type<Record<string, unknown>>(),
  maxDurationMs: int('max_duration_ms'),
  compensationFailureConfig: json('compensation_failure_config').$type<CompensationFailureConfig>(),
  version: int('version').notNull().default(1),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});

export const workflowSteps = mysqlTable('workflow_steps', {
  id: varchar('id', { length: 64 }).primaryKey(),
  workflowId: varchar('workflow_id', { length: 64 }).notNull().references(() => workflowDefinitions.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 191 }),
  stepOrder: int('step_order').notNull(),
  stepGroup: int('step_group').notNull().default(0),
  componentId: varchar('component_id', { length: 64 }).notNull().references(() => componentDefinitions.id),
  dependsOnStepId: varchar('depends_on_step_id', { length: 64 }),
  compensationService: varchar('compensation_service', { length: 128 }),
  compensationAction: varchar('compensation_action', { length: 128 }),
  condition: text('condition'),
  onFailure: varchar('on_failure', { length: 16 }).notNull().default('halt').$type<OnFailureMode>(),
  idempotencyKeyHeader: varchar('idempotency_key_header', { length: 128 }),
  verifyAction: varchar('verify_action', { length: 128 }),
});

export const executions = mysqlTable('executions', {
  executionId: varchar('execution_id', { length: 64 }).primaryKey(),
  type: varchar('type', { length: 16 }).notNull().$type<'saga' | 'service'>(),
  refName: varchar('ref_name', { length: 191 }).notNull(),
  service: varchar('service', { length: 128 }),
  action: varchar('action', { length: 128 }),
  groupId: varchar('group_id', { length: 64 }),
  status: varchar('status', { length: 32 }).notNull().$type<ExecutionStatus>(),
  context: json('context').notNull().$type<Record<string, unknown>>(),
  steps: json('steps').$type<ExecutionStep[]>(),
  result: json('result').$type<unknown>(),
  maxDurationMs: int('max_duration_ms'),
  errorCode: varchar('error_code', { length: 64 }),
  errorMessage: text('error_message'),
  errorDetails: json('error_details').$type<unknown>(),
  attempts: int('attempts').default(0),
  startedAt: varchar('started_at', { length: 32 }).notNull(),
  completedAt: varchar('completed_at', { length: 32 }),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});

export const executionLogs = mysqlTable('execution_logs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  executionId: varchar('execution_id', { length: 64 }).notNull(),
  workflowName: varchar('workflow_name', { length: 191 }),
  service: varchar('service', { length: 128 }),
  action: varchar('action', { length: 128 }),
  componentType: varchar('component_type', { length: 32 }),
  stepOrder: int('step_order'),
  status: varchar('status', { length: 16 }).notNull().$type<'success' | 'failed' | 'skipped'>(),
  requestData: text('request_data'),
  responseData: text('response_data'),
  errorMessage: text('error_message'),
  durationMs: int('duration_ms'),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
});

export const masterConfiguration = mysqlTable('master_configuration', {
  id: varchar('id', { length: 64 }).primaryKey(),
  key: varchar('key', { length: 191 }).notNull().unique(),
  value: text('value').notNull(),
  valueType: varchar('value_type', { length: 32 }).notNull().default('string'),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
  updatedAt: varchar('updated_at', { length: 32 }).notNull(),
});
