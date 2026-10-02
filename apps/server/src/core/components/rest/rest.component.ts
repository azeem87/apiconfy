import type {
  ComponentExecuteParams, ComponentExecuteResult, ComponentHandler, ComponentRequestSummary,
} from '@/core/components/base.js';
import type { RequestConfig, TimeoutConfig, ValidationField } from '@/core/types.js';
import { resolveTemplate } from '@/core/transform/index.js';
import { AuthRuntime, type AuthBlock } from '@/core/auth/authenticator.js';
import { buildTlsOptions } from './tls.js';
import { DEFAULT_TIMEOUT_MS } from '@/core/runtime/resilience-executor.js';
import { timedRequest } from './timed-transport.js';
import { mediaType, parseResponseBody } from '@/lib/http.js';
import {
  AppError, ConnectionError, ExternalServiceError, NotImplementedError, TimeoutError, TransformationError,
} from '@/lib/errors.js';

const JSON_TYPE = 'application/json';
const FORM_TYPE = 'application/x-www-form-urlencoded';

export class RestComponent implements ComponentHandler {
  readonly componentType = 'rest';

  private readonly authRuntime: AuthRuntime;

  private readonly httpRequest: typeof fetch;

  /** An injected `httpRequest` (tests) replaces both transports; connect/read timeouts need the default. */
  private readonly useSocketTransport: boolean;

  constructor(httpRequest?: typeof fetch) {
    this.useSocketTransport = httpRequest === undefined;
    this.httpRequest = httpRequest ?? globalThis.fetch;
    this.authRuntime = new AuthRuntime(this.httpRequest);
  }

  assertExecutable(config: Record<string, unknown>): void {
    const request = (config.request ?? {}) as Partial<RequestConfig>;
    const resilience = (config.resilience ?? {}) as Record<string, unknown>;
    const unsupported: Array<{ field: string; phase: string }> = [];
    if (request.auth?.jwt !== undefined) unsupported.push({ field: 'config.request.auth.jwt', phase: 'Phase 4' });
    if (resilience.circuitBreaker !== undefined) {
      unsupported.push({ field: 'config.resilience.circuitBreaker', phase: 'post-v1' });
    }
    if (request.contentType && ![JSON_TYPE, FORM_TYPE].includes(mediaType(request.contentType))) {
      unsupported.push({ field: 'config.request.contentType', phase: 'unscheduled' });
    }
    if (unsupported.length) {
      throw new NotImplementedError(
        `Configured but not implemented: ${unsupported.map(item => item.field).join(', ')}`,
        { unsupported }
      );
    }
  }

  private dispatch(uri: string, init: RequestInit, timeouts: TimeoutConfig | undefined): Promise<Response> {
    // With every timeout at its 60 s default, requestTimeout fires first, so fetch suffices.
    const needsSocketTransport = timeouts?.connectTimeout !== undefined || timeouts?.readTimeout !== undefined
      || (timeouts?.requestTimeout ?? 0) > DEFAULT_TIMEOUT_MS;
    if (!this.useSocketTransport || !needsSocketTransport) return this.httpRequest(uri, init);
    return timedRequest(uri, init, {
      connectTimeout: timeouts?.connectTimeout ?? DEFAULT_TIMEOUT_MS,
      readTimeout: timeouts?.readTimeout ?? DEFAULT_TIMEOUT_MS,
    });
  }

  validationFields(config: Record<string, unknown>): ValidationField[] {
    return (config.request as RequestConfig | undefined)?.validation?.fields ?? [];
  }

  async execute(params: ComponentExecuteParams): Promise<ComponentExecuteResult> {
    const request = params.config.request as RequestConfig;
    const uri = resolveTemplate(request.uri, params.context);
    if (typeof uri !== 'string') throw new TransformationError('Resolved uri is not a string');
    if (uri.includes('{$')) throw new TransformationError('Resolved uri contains an unresolved expression');

    let payload: unknown;
    let body: string | undefined;
    const headers = new Headers();
    try {
      // A9 (security review): No outbound header denylist. Operators control component
      // config; if they set Host/X-Forwarded-For/etc., it's intentional. Most upstream
      // APIs ignore these headers anyway. Add a denylist only if support tickets reveal
      // real-world misconfigurations.
      for (const [key, value] of Object.entries(request.headers ?? {})) {
        const resolved = resolveTemplate(value, params.context);
        if (resolved === undefined || resolved === null) continue;
        if (typeof resolved === 'string' && resolved.includes('{$')) continue;
        headers.set(key, String(resolved));
      }
      if (request.method !== 'GET') {
        // output belongs to the runtime, not the caller's fallback HTTP payload.
        const { output: _output, ...input } = params.context.context;
        payload = request.payloadTemplate === undefined
          ? input
          : resolveTemplate(request.payloadTemplate, params.context);
        if (payload !== null && payload !== undefined) {
          const contentType = request.contentType ?? JSON_TYPE;
          if (mediaType(contentType) === FORM_TYPE) {
            const form = new URLSearchParams();
            for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
              if (value === null || value === undefined) continue;
              form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
            }
            body = form.toString();
          } else {
            body = JSON.stringify(payload);
          }
          // Case-insensitive replacement prevents duplicate headers or a false media type.
          headers.set('Content-Type', contentType);
        }
      }
      headers.set('X-Execution-Id', params.executionId);
    } catch {
      throw new TransformationError('REST request could not be serialized');
    }
    const summary: ComponentRequestSummary = { uri, method: request.method, ...(body !== undefined ? { body: payload } : {}) };
    params.onRequest?.(summary);
    const tls = buildTlsOptions(request.ssl, request.disableSSL);
    const auth = request.auth as AuthBlock | undefined;
    const timeouts = params.config.timeout as TimeoutConfig | undefined;
    const onSecret = params.onSecret ?? (() => {});
    const send = async (): Promise<Response> => {
      if (auth) {
        const material = await this.authRuntime.resolve(auth, params.signal, onSecret);
        headers.set(material.name, material.value);
      }
      return this.dispatch(uri, {
        method: request.method, headers, body, signal: params.signal, ...(tls ? { tls } : {}),
      } as RequestInit, timeouts);
    };
    try {
      let response = await send();
      // A 401 may mean the cached token expired or was revoked: drop it and replay once.
      if (response.status === 401 && auth && this.authRuntime.canReplay(auth)) {
        await response.body?.cancel();
        this.authRuntime.invalidate(auth);
        response = await send();
      }
      let data: unknown;
      try {
        data = await parseResponseBody(response);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        data = null;
      }
      if (params.signal.aborted) throw new TimeoutError();
      if (!response.ok) {
        throw new ExternalServiceError(`External API returned ${response.status}`, response.status, {
          downstream: { status: response.status, body: data },
        });
      }
      return { data, request: summary };
    } catch (error) {
      if (params.signal.aborted) throw new TimeoutError();
      if (error instanceof AppError) throw error;
      // Transport messages can contain credentials; never reflect the raw exception.
      throw new ConnectionError(`Failed to reach ${request.method} ${uri}`);
    }
  }
}
