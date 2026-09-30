import type { ScriptFailureReason, ScriptWorkerReply, ScriptWorkerRequest } from './script-worker.js';
import type { ScriptHostBridge } from './script-bridge.js';

/**
 * S4 (script-component.md §9): the bundler does **not** emit a worker referenced through a static
 * `new URL('./script-worker.ts', import.meta.url)`, so the worker ships as its own build entry
 * (see `apps/server/package.json`). Dev runs TypeScript directly; the bundle is JavaScript.
 */
const WORKER_URL = new URL(
  `./script-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
  import.meta.url
);

export interface ScriptEvaluationParams {
  expression: string;
  context: Record<string, unknown>;
  signal: AbortSignal;
  executionId: string;
  bridge: ScriptHostBridge;
}

/** `deadline` is ours; the rest come from the worker's classification (script-component.md §5). */
export type ScriptEvaluationFailure = ScriptFailureReason | 'deadline';

export class ScriptEvaluationError extends Error {
  constructor(public readonly reason: ScriptEvaluationFailure) {
    super(`Script evaluation failed: ${reason}`);
    this.name = 'ScriptEvaluationError';
  }
}

export interface ScriptEvaluator {
  /** Resolves with the contribution delta — the `$context` variables the script changed. */
  evaluate(params: ScriptEvaluationParams): Promise<unknown>;
}

/**
 * One worker per evaluation, terminated on every exit path — a leaked worker would cost a thread
 * and its memory per invocation. Measured cost: p50 2.9 ms, p95 3.8 ms (script-component.md §9 S2),
 * so no pool is needed and no scope is ever reused.
 */
export class WorkerScriptEvaluator implements ScriptEvaluator {
  constructor(private readonly workerUrl: URL | string = WORKER_URL) {}

  evaluate({ expression, context, signal, executionId, bridge }: ScriptEvaluationParams): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (signal.aborted) {
        reject(new ScriptEvaluationError('deadline'));
        return;
      }

      let worker: Worker;
      try {
        worker = new Worker(this.workerUrl);
      } catch {
        reject(new ScriptEvaluationError('evaluation-failed'));
        return;
      }

      let settled = false;
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        worker.terminate();
        settle();
      };
      const fail = (reason: ScriptEvaluationFailure): void =>
        finish(() => reject(new ScriptEvaluationError(reason)));
      // `terminate()` is what makes the deadline real: it kills a spinning loop (measured: 0.02 ms).
      const onAbort = (): void => fail('deadline');

      /** Post to the worker only while the evaluation is alive — late RPC replies are dropped. */
      const reply = (message: Extract<ScriptWorkerRequest, { kind: 'rpc-result' }>): void => {
        if (settled) return;
        worker.postMessage(message);
      };

      const handleRpc = async (message: Extract<ScriptWorkerReply, { kind: 'rpc' }>): Promise<void> => {
        let envelope: unknown;
        try {
          const params = JSON.parse(message.paramsJson) as {
            service?: string; action?: string; context?: Record<string, unknown>;
            workflowName?: string; name?: string; params?: Record<string, unknown>;
          };
          if (message.method === 'invoke') {
            envelope = await bridge.invoke({
              service: params.service ?? '', action: params.action ?? '', context: params.context ?? {},
            });
          } else if (message.method === 'executeWorkflow') {
            envelope = await bridge.executeWorkflow({
              workflowName: params.workflowName ?? '', context: params.context ?? {},
            });
          } else {
            envelope = await bridge.generate({ name: params.name ?? '', params: params.params });
          }
        } catch {
          // The bridge never throws by contract; this is belt-and-braces (script-component.md §17).
          envelope = {
            success: false, data: null,
            error: { code: 'INTERNAL_ERROR', message: 'Script bridge call failed' },
          };
        }
        reply({ kind: 'rpc-result', id: message.id, payloadJson: JSON.stringify(envelope ?? null) });
      };

      signal.addEventListener('abort', onAbort, { once: true });

      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as ScriptWorkerReply;
        if (message.kind === 'rpc') {
          void handleRpc(message);
          return;
        }
        if (!message.ok) {
          fail(message.reason);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.contributionJson);
        } catch {
          fail('not-serializable');
          return;
        }
        finish(() => resolve(parsed));
      };

      const handle = worker as unknown as { onerror?: (error: unknown) => void; onclose?: () => void };
      handle.onerror = () => fail('evaluation-failed');
      handle.onclose = () => fail('evaluation-failed');

      const request: ScriptWorkerRequest = { kind: 'eval', expression, context, executionId };
      worker.postMessage(request);
    });
  }
}

/** Deterministic stand-in for unit tests; never spawns a worker. */
export class FakeScriptEvaluator implements ScriptEvaluator {
  constructor(private readonly result: unknown | (() => unknown)) {}

  async evaluate(): Promise<unknown> {
    return typeof this.result === 'function' ? (this.result as () => unknown)() : this.result;
  }
}
