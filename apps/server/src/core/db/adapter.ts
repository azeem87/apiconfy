export type DbType = 'sqlite' | 'postgres';

export interface ComponentRecord {
  id: string;
  service: string;
  action: string;
  componentType: string;
  description?: string;
  config: Record<string, unknown>;
  condition?: string;
  metaData?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  groupId?: string;
  description?: string;
  responseMapping?: Record<string, unknown>;
  maxDurationMs?: number;
  compensationFailureConfig?: CompensationFailureConfig;
  createdAt: string;
  updatedAt: string;
}

export type OnFailureMode = 'halt' | 'continue' | 'compensate';

export interface CompensationFailureConfig {
  maxRetries: number;
  onExhausted: 'deadLetter' | 'alert' | 'ignore';
}

export interface WorkflowStepRecord {
  id: string;
  workflowId: string;
  name?: string;
  stepOrder: number;
  stepGroup: number;
  componentId: string;
  dependsOnStepId?: string;
  /** Defaults to the step's own component service when omitted. */
  compensationService?: string;
  compensationAction?: string;
  condition?: string;
  onFailure: OnFailureMode;
  idempotencyKeyHeader?: string;
  verifyAction?: string;
}

export interface ExecutionLogRecord {
  id: string;
  executionId: string;
  workflowName?: string;
  service?: string;
  action?: string;
  componentType?: string;
  stepOrder?: number;
  status: 'success' | 'failed' | 'skipped';
  requestData?: string;
  responseData?: string;
  errorMessage?: string;
  durationMs?: number;
  createdAt: string;
}

export interface ComponentFilters { service?: string; componentType?: string }

export interface DBAdapter {
  type: DbType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  saveComponent(comp: ComponentRecord): Promise<ComponentRecord>;
  getComponent(id: string): Promise<ComponentRecord | null>;
  findComponent(service: string, action: string): Promise<ComponentRecord | null>;
  listComponents(filters?: ComponentFilters, limit?: number, offset?: number): Promise<ComponentRecord[]>;
  countComponents(filters?: ComponentFilters): Promise<number>;
  updateComponent(id: string, changes: Partial<ComponentRecord>): Promise<ComponentRecord>;
  deleteComponent(id: string): Promise<void>;

  saveWorkflow(wf: WorkflowRecord): Promise<WorkflowRecord>;
  getWorkflow(id: string): Promise<WorkflowRecord | null>;
  findWorkflowByName(name: string): Promise<WorkflowRecord | null>;
  listWorkflows(limit?: number, offset?: number): Promise<WorkflowRecord[]>;
  updateWorkflow(id: string, changes: Partial<WorkflowRecord>): Promise<WorkflowRecord>;
  deleteWorkflow(id: string): Promise<void>;

  saveWorkflowStep(step: WorkflowStepRecord): Promise<WorkflowStepRecord>;
  getWorkflowSteps(workflowId: string): Promise<WorkflowStepRecord[]>;
  deleteWorkflowSteps(workflowId: string): Promise<void>;

  saveExecutionLog(log: ExecutionLogRecord): Promise<ExecutionLogRecord>;
  getExecutionLogs(executionId: string): Promise<ExecutionLogRecord[]>;

  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string, valueType: string): Promise<void>;
  deleteConfig(key: string): Promise<void>;
}
