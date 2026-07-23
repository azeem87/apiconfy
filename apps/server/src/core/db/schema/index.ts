import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const componentDefinitions = sqliteTable('component_definitions', {
  id: text('id').primaryKey(),
  serviceName: text('service_name').notNull(),
  serviceType: text('service_type').notNull(),
  component: text('component').notNull(),
  description: text('description'),
  serviceDetails: text('service_details', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  condition: text('condition'),
  metaData: text('meta_data', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  naturalKeyIdx: uniqueIndex('natural_key_idx').on(table.serviceName, table.component, table.serviceType),
}));

export const workflowDefinitions = sqliteTable('workflow_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  responseMapping: text('response_mapping', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workflowSteps = sqliteTable('workflow_steps', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull().references(() => workflowDefinitions.id, { onDelete: 'cascade' }),
  stepOrder: integer('step_order').notNull(),
  stepGroup: integer('step_group').notNull().default(0),
  componentId: text('component_id').notNull().references(() => componentDefinitions.id),
  dependsOnStepId: text('depends_on_step_id'),
  rollbackServiceName: text('rollback_service_name'),
  rollbackServiceType: text('rollback_service_type'),
  rollbackAllPrevious: integer('rollback_all_previous', { mode: 'boolean' }).notNull().default(false),
});

export const executionLogs = sqliteTable('execution_logs', {
  id: text('id').primaryKey(),
  executionId: text('execution_id').notNull(),
  workflowName: text('workflow_name'),
  serviceName: text('service_name'),
  serviceType: text('service_type'),
  component: text('component'),
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
