export type DbType = 'sqlite' | 'postgres';

export interface ComponentRecord {
  id: string;
  serviceName: string;
  serviceType: string;
  component: string;
  description?: string;
  serviceDetails: Record<string, unknown>;
  condition?: string;
  metaData?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  description?: string;
  responseMapping?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepRecord {
  id: string;
  workflowId: string;
  stepOrder: number;
  stepGroup: number;
  componentId: string;
  dependsOnStepId?: string;
  rollbackServiceName?: string;
  rollbackServiceType?: string;
  rollbackAllPrevious: boolean;
}

export interface ExecutionLogRecord {
  id: string;
  executionId: string;
  workflowName?: string;
  serviceName?: string;
  serviceType?: string;
  component?: string;
  stepOrder?: number;
  status: 'success' | 'failed' | 'skipped';
  requestData?: string;
  responseData?: string;
  errorMessage?: string;
  durationMs?: number;
  createdAt: string;
}

export interface DBAdapter {
  type: DbType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  saveComponent(comp: ComponentRecord): Promise<ComponentRecord>;
  getComponent(id: string): Promise<ComponentRecord | null>;
  findComponent(serviceName: string, component: string, serviceType: string): Promise<ComponentRecord | null>;
  listComponents(filters?: { serviceName?: string; component?: string }, limit?: number, offset?: number): Promise<ComponentRecord[]>;
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
