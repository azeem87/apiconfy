import { z } from 'zod';
import type { DBAdapter, WorkflowRecord } from '@/core/db/adapter.js';
import type { ComponentLookup } from '@/core/runtime/types.js';
import type { RuntimeExecutor } from '@/core/runtime/runtime-executor.js';
import { resolveTemplate } from '@/core/transform/index.js';
import { ConflictError, NotFoundError, ValidationError, generateId } from '@/lib/index.js';

const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(z.object({
    name: z.string().min(1).optional(),
    service: z.string().min(1),
    action: z.string().min(1),
    onFailure: z.enum(['halt', 'continue']).default('halt'),
  }).strict()).min(1),
  responseMapping: z.record(z.unknown()).optional(),
}).strict();

export interface WorkflowExecution {
  executionId: string;
  data: Record<string, unknown>;
}

/**
 * Sequential workflow runner. Each step is a first-class component execution; its `data` merges
 * flat into the shared `$context` (later writes win) and feeds the next step.
 */
export class WorkflowService {
  constructor(
    private readonly db: DBAdapter,
    private readonly components: ComponentLookup,
    private readonly executor: RuntimeExecutor,
  ) {}

  async create(body: unknown): Promise<WorkflowRecord> {
    const parsed = WorkflowDefinitionSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body', parsed.error.issues.map(issue => ({
        path: issue.path, message: issue.message,
      })));
    }
    const { name, description, steps, responseMapping } = parsed.data;
    if (await this.db.findWorkflowByName(name)) {
      throw new ConflictError(`Workflow already exists: ${name}`);
    }
    const resolved = await Promise.all(steps.map(async step => {
      const component = await this.components.findByKey(step.service, step.action);
      if (!component) throw new ValidationError(`Unknown component: ${step.service}/${step.action}`);
      return { step, component };
    }));
    const now = new Date().toISOString();
    const workflow = await this.db.saveWorkflow({
      id: generateId(), name, description, responseMapping, version: 1, createdAt: now, updatedAt: now,
    });
    for (const [index, { step, component }] of resolved.entries()) {
      await this.db.saveWorkflowStep({
        id: generateId(), workflowId: workflow.id, name: step.name,
        stepOrder: index, stepGroup: index, componentId: component.id, onFailure: step.onFailure,
      });
    }
    return workflow;
  }

  async execute(workflowName: string, input: Record<string, unknown>,
    executionId = generateId(),
  ): Promise<WorkflowExecution> {
    const workflow = await this.db.findWorkflowByName(workflowName);
    if (!workflow) throw new NotFoundError(`Workflow not found: ${workflowName}`);
    const steps = await this.db.getWorkflowSteps(workflow.id);
    const context: Record<string, unknown> = { ...input };
    const contributions: Record<string, unknown> = {};

    for (const step of steps) {
      const component = await this.db.getComponent(step.componentId);
      if (!component) throw new NotFoundError(`Component not found for step ${step.name ?? step.stepOrder}`);
      try {
        const result = await this.executor.invoke({
          service: component.service, action: component.action,
          context: { ...context }, executionId: generateId(), startedAtMs: Date.now(),
        });
        const data = result.data;
        if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
          Object.assign(context, data);
          Object.assign(contributions, data);
        }
      } catch (caught) {
        if (step.onFailure !== 'continue') throw caught;
      }
    }

    const data = workflow.responseMapping
      ? resolveTemplate(workflow.responseMapping, { context, env: {}, output: null }) as Record<string, unknown>
      : contributions;
    return { executionId, data };
  }
}
