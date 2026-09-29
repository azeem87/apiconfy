import { describe, it, expect } from 'bun:test';
import {
  ScriptEvaluationError, WorkerScriptEvaluator, type ScriptEvaluationParams,
} from '@/core/runtime/script-evaluator.js';
import type { ScriptHostBridge } from '@/core/runtime/script-bridge.js';

const evaluator = new WorkerScriptEvaluator();

function fakeBridge(overrides: Partial<ScriptHostBridge> = {}) {
  const calls: Array<{ method: string; request: unknown }> = [];
  const bridge: ScriptHostBridge = {
    async invoke(request) {
      calls.push({ method: 'invoke', request });
      return { success: true, data: { echoed: request.service }, meta: { executionId: 'nested-1', durationMs: 1 } };
    },
    async executeWorkflow(request) {
      calls.push({ method: 'executeWorkflow', request });
      return { success: false, data: null, error: { code: 'NOT_IMPLEMENTED', message: 'Phase 5' }, meta: {} };
    },
    async generate(request) {
      calls.push({ method: 'generate', request });
      return { success: false, data: null, error: { code: 'NOT_IMPLEMENTED', message: '$gen ships Phase 5+' } };
    },
    ...overrides,
  };
  return { bridge, calls };
}

function evaluate(
  expression: string,
  context: Record<string, unknown> = {},
  options: Partial<Pick<ScriptEvaluationParams, 'signal' | 'bridge' | 'executionId'>> = {}
): Promise<unknown> {
  return evaluator.evaluate({
    expression,
    context,
    signal: options.signal ?? new AbortController().signal,
    executionId: options.executionId ?? 'exec-1',
    bridge: options.bridge ?? fakeBridge().bridge,
  });
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch(caught => caught);
  expect(error).toBeInstanceOf(ScriptEvaluationError);
  return (error as ScriptEvaluationError).reason;
}

describe('WorkerScriptEvaluator (real worker)', () => {
  it('returns only the changed top-level variables as the contribution — add, modify, nested', async () => {
    const result = await evaluate(
      'async function ($c) { $c.added = 1; $c.existing = { ...$c.existing, touched: true }; $c.nested.deep = 2; return 42; }',
      { existing: { touched: false }, nested: { deep: 1 }, untouched: 'same' }
    );
    // `return 42` is ignored — the contribution is the delta (and `untouched` never appears).
    expect(result).toEqual({
      added: 1,
      existing: { touched: true },
      nested: { deep: 2 },
    });
  });

  it('reports an empty delta when the script changes nothing', async () => {
    const result = await evaluate('function ($c) { /* no writes */ }', { a: 1 });
    expect(result).toEqual({});
  });

  it('passes the live $context to apiconfy.invoke implicitly — before-call writes included', async () => {
    const { bridge, calls } = fakeBridge();
    const result = await evaluate(
      'async function ($c) { $c.before = true; const r = await apiconfy.invoke("echo", "go"); $c.nested = r; }',
      { id: 7 },
      { bridge }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].request).toEqual({ service: 'echo', action: 'go', context: { id: 7, before: true } });
    expect(result).toEqual({
      before: true,
      nested: { success: true, data: { echoed: 'echo' }, meta: { executionId: 'nested-1', durationMs: 1 } },
    });
  });

  it('honours an explicit narrower context on a nested call', async () => {
    const { bridge, calls } = fakeBridge();
    await evaluate(
      'async function ($c) { await apiconfy.invoke("echo", "go", { id: $c.id }); }',
      { id: 7, secretish: 'not sent' },
      { bridge }
    );
    expect(calls[0].request).toEqual({ service: 'echo', action: 'go', context: { id: 7 } });
  });

  it('exposes apiconfy.executionId and supports parallel awaits', async () => {
    const started: string[] = [];
    const parallel = fakeBridge({
      invoke: async request => {
        started.push(request.action);
        await new Promise(resolve => setTimeout(resolve, 10));
        return { success: true, data: request.action, meta: { executionId: `n-${request.action}`, durationMs: 1 } };
      },
    });
    const result = await evaluate(
      'async function ($c) { const [a, b] = await Promise.all([apiconfy.invoke("s", "a"), apiconfy.invoke("s", "b")]); $c.execId = apiconfy.executionId; $c.pair = [a.data, b.data]; }',
      {},
      { bridge: parallel.bridge }
    );
    expect(result).toEqual({ execId: 'exec-1', pair: ['a', 'b'] });
    expect(started.sort()).toEqual(['a', 'b']);
  });

  it('classifies non-serializable nested-call arguments locally, without a host round trip', async () => {
    const { bridge, calls } = fakeBridge();
    const result = await evaluate(
      'async function ($c) { $c.failure = await apiconfy.invoke("s", "a", { big: 10n }); }',
      {},
      { bridge }
    );
    expect(calls).toHaveLength(0);
    expect(result).toEqual({
      failure: {
        success: false, data: null,
        error: {
          code: 'SCRIPT_ERROR',
          message: 'Nested call arguments are not JSON-serializable',
          details: { reason: 'not-serializable' },
        },
      },
    });
  });

  it('classifies throws and async rejections as threw', async () => {
    expect(await reasonOf(evaluate('function ($c) { throw new Error("x"); }'))).toBe('threw');
    expect(await reasonOf(evaluate('async function ($c) { await Promise.reject(new Error("x")); }'))).toBe('threw');
  });

  it('classifies a non-function source as not-a-function', async () => {
    expect(await reasonOf(evaluate('42'))).toBe('not-a-function');
  });

  it('classifies an unbuildable source as evaluation-failed', async () => {
    expect(await reasonOf(evaluate('function ('))).toBe('evaluation-failed');
  });

  it('classifies a non-serializable contribution as not-serializable', async () => {
    expect(await reasonOf(evaluate('function ($c) { $c.big = 10n; }'))).toBe('not-serializable');
  });

  it('rejects immediately as deadline when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await reasonOf(evaluate('function ($c) {}', {}, { signal: controller.signal }))).toBe('deadline');
  });

  it('kills a spinning while(true) at abort, then still works — no poisoned worker', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = evaluate('function ($c) { while (true) {} }', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 25);

    expect(await reasonOf(pending)).toBe('deadline');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await evaluate('function ($c) { $c.ok = true; }')).toEqual({ ok: true });
  });

  it('supports optional chaining and template literals end to end', async () => {
    const result = await evaluate(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the expression source intentionally contains JS template interpolation
      'function ($c) { $c.label = `Hi ${$c?.user?.name ?? "anon"}`; }',
      { user: { name: 'Ada' } }
    );
    expect(result).toEqual({ label: 'Hi Ada' });
  });
});
