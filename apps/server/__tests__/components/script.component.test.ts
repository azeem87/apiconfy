import { describe, it, expect } from 'bun:test';
import { ScriptComponent } from '@/core/components/script/script.component.js';
import { ScriptEvaluationError, type ScriptEvaluationParams, type ScriptEvaluator } from '@/core/runtime/script-evaluator.js';
import type { ScriptHostBridge } from '@/core/runtime/script-bridge.js';
import type { ComponentExecuteParams } from '@/core/components/base.js';
import { ScriptError, TimeoutError } from '@/lib/errors.js';

const params = (signal = new AbortController().signal): ComponentExecuteParams => ({
  config: { expression: 'ignored — the fake evaluator stands in' },
  context: { context: { id: 1 }, env: {}, output: null },
  signal,
  executionId: 'exec-9',
});

const evaluatorFailing = (error: unknown): ScriptEvaluator => ({
  evaluate: async () => { throw error; },
});

describe('ScriptComponent', () => {
  it('returns the evaluator contribution as handler data and forwards executionId + bridge', async () => {
    let received: ScriptEvaluationParams | undefined;
    const bridge: ScriptHostBridge = {
      async invoke() { throw new Error('unused'); },
      async executeWorkflow() { throw new Error('unused'); },
      async generate() { throw new Error('unused'); },
    };
    const evaluator: ScriptEvaluator = {
      async evaluate(input) { received = input; return { calculateTotalResponse: { total: 110 } }; },
    };
    const component = new ScriptComponent(evaluator, bridge);

    const result = await component.execute(params());

    expect(result).toEqual({ data: { calculateTotalResponse: { total: 110 } } });
    expect(received!.executionId).toBe('exec-9');
    expect(received!.bridge).toBe(bridge);
    expect(received!.context).toEqual({ id: 1 });
    expect(received!.expression).toContain('fake evaluator');
  });

  it('defaults to the unavailable bridge when none is injected', async () => {
    let received: ScriptEvaluationParams | undefined;
    const evaluator: ScriptEvaluator = {
      async evaluate(input) { received = input; return {}; },
    };
    await new ScriptComponent(evaluator).execute(params());

    const envelope = await received!.bridge.generate({ name: 'uuid' });
    expect((envelope as { error: { code: string } }).error.code).toBe('NOT_IMPLEMENTED');
  });

  it('maps a deadline evaluation failure to TimeoutError (504 path)', async () => {
    const component = new ScriptComponent(evaluatorFailing(new ScriptEvaluationError('deadline')));
    await expect(component.execute(params())).rejects.toBeInstanceOf(TimeoutError);
  });

  it.each(['threw', 'not-a-function', 'not-serializable', 'evaluation-failed'] as const)(
    'maps the %s reason to ScriptError with the reason in the message', async reason => {
      const component = new ScriptComponent(evaluatorFailing(new ScriptEvaluationError(reason)));
      const error = await component.execute(params()).catch(caught => caught as ScriptError);

      expect(error).toBeInstanceOf(ScriptError);
      expect((error as ScriptError).message).toContain(reason);
      expect((error as ScriptError).statusCode).toBe(500);
    }
  );

  it('rethrows a foreign error unchanged', async () => {
    const foreign = new Error('transport blew up');
    const component = new ScriptComponent(evaluatorFailing(foreign));
    await expect(component.execute(params())).rejects.toBe(foreign);
  });
});
