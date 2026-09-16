import type {
  ComponentExecuteParams, ComponentExecuteResult, ComponentHandler, ComponentRequestSummary,
} from '@/core/components/base.js';
import type { RequestConfig } from '@/core/types.js';
import { resolveTemplate } from '@/core/transform/index.js';
import { parseResponseBody } from '@/lib/http.js';
import {
  AppError, ConnectionError, ExternalServiceError, NotImplementedError, TimeoutError, TransformationError,
} from '@/lib/errors.js';

const JSON_TYPE = 'application/json';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const mediaType = (value: string) => value.split(';')[0].trim().toLowerCase();

export class RestComponent implements ComponentHandler {
  readonly componentType = 'rest';
  readonly displayName = 'REST API';

  constructor(private readonly httpRequest: typeof fetch = globalThis.fetch) {}

  assertExecutable(config: Record<string, unknown>): void {
    const request = (config.request ?? {}) as Partial<RequestConfig>;
    const timeout = (config.timeout ?? {}) as Record<string, unknown>;
    const resilience = (config.resilience ?? {}) as Record<string, unknown>;
    const unsupported: Array<{ field: string; phase: string }> = [];
    for (const field of ['auth', 'ssl'] as const) {
      if (request[field] !== undefined) unsupported.push({ field: `config.request.${field}`, phase: 'Phase 4' });
    }
    if (request.disableSSL === true) unsupported.push({ field: 'config.request.disableSSL', phase: 'Phase 4' });
    if (resilience.circuitBreaker !== undefined) {
      unsupported.push({ field: 'config.resilience.circuitBreaker', phase: 'post-v1' });
    }
    for (const field of ['connect', 'socket', 'idle']) {
      if (timeout[field] !== undefined) unsupported.push({ field: `config.timeout.${field}`, phase: 'Phase 4' });
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

  async execute(params: ComponentExecuteParams): Promise<ComponentExecuteResult> {
    const request = params.config.request as RequestConfig;
    const uri = resolveTemplate(request.uri, params.context);
    if (typeof uri !== 'string') throw new TransformationError('Resolved uri is not a string');
    if (uri.includes('{$')) throw new TransformationError('Resolved uri contains an unresolved expression');

    let payload: unknown;
    let body: string | undefined;
    const headers = new Headers();
    try {
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
    try {
      const response = await this.httpRequest(uri, {
        method: request.method, headers, body, signal: params.signal,
      });
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
      return { statusCode: response.status, data, request: summary };
    } catch (error) {
      if (params.signal.aborted) throw new TimeoutError();
      if (error instanceof AppError) throw error;
      // Transport messages can contain credentials; never reflect the raw exception.
      throw new ConnectionError(`Failed to reach ${request.method} ${uri}`);
    }
  }
}
