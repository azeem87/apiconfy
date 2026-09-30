/**
 * Script-component worker entry (Phase 3.5 — plans/script-component.md §4.3–4.4, §17).
 *
 * This file is loaded as a Bun Worker: it is the only place operator source is ever evaluated.
 *
 * The script contributes by mutating `$context`; the reply carries only the changed/added
 * top-level variables (the contribution). A `return` value is ignored (D5).
 *
 * It also hosts the `apiconfy` tools (frozen, delivered as a factory parameter): `invoke`,
 * `executeWorkflow` and `generate` are RPC calls back to the host, and their `context`
 * defaults to the live `$context` copy (snapshotted at call time).
 *
 * No imports — it must be bundleable as a standalone entry (S4). Failures are classified only:
 * never a stack, a message, or the source itself (D10).
 */

// host → worker
export type ScriptWorkerRequest =
  | { kind: 'eval'; expression: string; context: Record<string, unknown>; executionId: string }
  | { kind: 'rpc-result'; id: number; payloadJson: string };

// worker → host
export type ScriptWorkerReply =
  | { kind: 'result'; ok: true; contributionJson: string }
  | { kind: 'result'; ok: false; reason: ScriptFailureReason }
  | { kind: 'rpc'; id: number; method: ScriptRpcMethod; paramsJson: string };

export type ScriptFailureReason = 'threw' | 'not-a-function' | 'not-serializable' | 'evaluation-failed';
export type ScriptRpcMethod = 'invoke' | 'executeWorkflow' | 'generate';

/**
 * Shadowed in the evaluated scope. This stops accidents — a sloppy expression cannot read
 * `process.env`, `require('node:fs')` or `fetch` — but it is NOT a sandbox: the prototype-chain
 * escape (`({}).constructor.constructor(...)`) still reaches the real global. The boundary is
 * registry access, not this list (§4.4, §4.6 — measured in §9 S3).
 */
const BLOCKED_GLOBALS = [
  'process', 'require', 'module', 'exports', 'Bun', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'Request', 'Response', 'Headers', 'globalThis', 'console', 'setTimeout', 'setInterval',
  'queueMicrotask', 'Worker', 'Deno', 'navigator', 'location',
] as const;

const SHADOWED_SCOPE = BLOCKED_GLOBALS.map(name => `const ${name} = undefined;`).join(' ');

interface WorkerGlobal {
  onmessage: ((event: { data: ScriptWorkerRequest }) => void) | null;
  postMessage: (reply: ScriptWorkerReply) => void;
}

const workerGlobal = globalThis as unknown as WorkerGlobal;

/** null = "not JSON-serializable" — a sentinel so a new BigInt key still diffs as changed. */
function snapshotValue(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** Envelope-shaped failure for a call the worker resolves locally (never rejects, §17 B2). */
function callFailure(code: string, message: string, details?: Record<string, unknown>) {
  return { success: false, data: null, error: { code, message, ...(details ? { details } : {}) } };
}

let nextRpcId = 1;
const pending = new Map<number, (envelope: unknown) => void>();

function rpc(method: ScriptRpcMethod, params: unknown): Promise<unknown> {
  return new Promise(resolve => {
    let paramsJson: string;
    try {
      paramsJson = JSON.stringify(params);
    } catch {
      // BigInt/cycles/functions in the call arguments — classified locally, no round trip (§17).
      resolve(callFailure('SCRIPT_ERROR', 'Nested call arguments are not JSON-serializable', { reason: 'not-serializable' }));
      return;
    }
    const id = nextRpcId++;
    pending.set(id, resolve);
    workerGlobal.postMessage({ kind: 'rpc', id, method, paramsJson });
  });
}

workerGlobal.onmessage = (event: { data: ScriptWorkerRequest }) => {
  const message = event.data;
  if (message.kind === 'rpc-result') {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    if (!resolve) return; // Late reply after the evaluation finished — the worker is being torn down.
    let envelope: unknown;
    try {
      envelope = JSON.parse(message.payloadJson);
    } catch {
      envelope = callFailure('INTERNAL_ERROR', 'Malformed bridge response');
    }
    resolve(envelope);
    return;
  }
  void evaluate(message);
};

async function evaluate(
  { expression, context: bag, executionId }: Extract<ScriptWorkerRequest, { kind: 'eval' }>
): Promise<void> {
  const apiconfy = Object.freeze({
    executionId,
    invoke: (service: string, action: string, callContext: Record<string, unknown> = bag) =>
      rpc('invoke', { service, action, context: callContext }),
    executeWorkflow: (workflowName: string, callContext: Record<string, unknown> = bag) =>
      rpc('executeWorkflow', { workflowName, context: callContext }),
    generate: (name: string, params?: Record<string, unknown>) => rpc('generate', { name, params }),
  });

  let candidate: unknown;
  try {
    // Built inside the worker only. A build failure means the stored source is not evaluable
    // (registration validates syntax with a compile-only check, so this is a bypassed row).
    candidate = new Function('apiconfy', `{ ${SHADOWED_SCOPE} return (${expression}\n); }`)(apiconfy);
  } catch {
    workerGlobal.postMessage({ kind: 'result', ok: false, reason: 'evaluation-failed' });
    return;
  }

  if (typeof candidate !== 'function') {
    workerGlobal.postMessage({ kind: 'result', ok: false, reason: 'not-a-function' });
    return;
  }

  // Snapshot the top-level keys so the contribution can be diffed after the call (D9: JSON text).
  const before = new Map<string, string | null>(
    Object.entries(bag).map(([key, value]): [string, string | null] => [key, snapshotValue(value)])
  );

  try {
    // Awaited, so `async function` + `await apiconfy.invoke(...)` work; the return is ignored (D5).
    await (candidate as ($context: Record<string, unknown>) => unknown)(bag);
  } catch {
    workerGlobal.postMessage({ kind: 'result', ok: false, reason: 'threw' });
    return;
  }

  const contribution: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    const json = snapshotValue(value);
    if (!before.has(key) || before.get(key) !== json) contribution[key] = value;
  }

  let contributionJson: string;
  try {
    contributionJson = JSON.stringify(contribution);
  } catch {
    // BigInt, cycles, functions in the contribution — the classification must be explicit (measured in §9 S3).
    workerGlobal.postMessage({ kind: 'result', ok: false, reason: 'not-serializable' });
    return;
  }

  workerGlobal.postMessage({ kind: 'result', ok: true, contributionJson });
}
