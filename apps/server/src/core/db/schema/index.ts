import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { CompensationFailureConfig, OnFailureMode } from '../adapter.js';
import type { ExecutionStatus, ExecutionStep } from '@/core/types.js';

export const componentDefinitions = sqliteTable('component_definitions', {
  id: text('id').primaryKey(),
  service: text('service').notNull(),
  action: text('action').notNull(),
  componentType: text('component_type').notNull(),
  description: text('description'),
  config: text('config', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  condition: text('condition'),
  metaData: text('meta_data', { mode: 'json' }).$type<Record<string, unknown>>(),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  naturalKeyIdx: uniqueIndex('natural_key_idx').on(table.service, table.action),
}));

export const workflowDefinitions = sqliteTable('workflow_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  groupId: text('group_id'),
  description: text('description'),
  responseMapping: text('response_mapping', { mode: 'json' }).$type<Record<string, unknown>>(),
  maxDurationMs: integer('max_duration_ms'),
  compensationFailureConfig: text('compensation_failure_config', { mode: 'json' }).$type<CompensationFailureConfig>(),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workflowSteps = sqliteTable('workflow_steps', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull().references(() => workflowDefinitions.id, { onDelete: 'cascade' }),
  name: text('name'),
  stepOrder: integer('step_order').notNull(),
  stepGroup: integer('step_group').notNull().default(0),
  componentId: text('component_id').notNull().references(() => componentDefinitions.id),
  dependsOnStepId: text('depends_on_step_id'),
  compensationService: text('compensation_service'),
  compensationAction: text('compensation_action'),
  condition: text('condition'),
  onFailure: text('on_failure').notNull().default('halt').$type<OnFailureMode>(),
  idempotencyKeyHeader: text('idempotency_key_header'),
  verifyAction: text('verify_action'),
});

export const executions = sqliteTable('executions', {
  executionId: text('execution_id').primaryKey(),
  type: text('type').notNull().$type<'saga' | 'service'>(),
  refName: text('ref_name').notNull(),
  service: text('service'),
  action: text('action'),
  groupId: text('group_id'),
  status: text('status').notNull().$type<ExecutionStatus>(),
  context: text('context', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  steps: text('steps', { mode: 'json' }).$type<ExecutionStep[]>(),
  result: text('result', { mode: 'json' }).$type<unknown>(),
  maxDurationMs: integer('max_duration_ms'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  errorDetails: text('error_details', { mode: 'json' }).$type<unknown>(),
  attempts: integer('attempts').default(1),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const executionLogs = sqliteTable('execution_logs', {
  id: text('id').primaryKey(),
  executionId: text('execution_id').notNull(),
  workflowName: text('workflow_name'),
  service: text('service'),
  action: text('action'),
  componentType: text('component_type'),
  stepOrder: integer('step_order'),
  status: text('status').notNull().$type<'success' | 'failed' | 'skipped'>(),
  // Stored as plain text — may be JSON or raw response body, intentionally not auto-parsed
  requestData: text('request_data'),
  responseData: text('response_data'),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),
  createdAt: text('created_at').notNull(),
});

export const masterConfiguration = sqliteTable('master_configuration', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  valueType: text('value_type').notNull().default('string'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
