import http from 'node:http';
import https from 'node:https';
import { ConnectionError, TimeoutError } from '@/lib/errors.js';

export interface TransportTimeouts {
  /** Max time to establish the TCP connection (plus the TLS handshake for https). */
  connectTimeout?: number;
  /** Max idle time waiting for response data, re-armed on every chunk. */
  readTimeout?: number;
}

export type TimedInit = RequestInit & { tls?: Record<string, unknown> };

const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Socket-level HTTP client: Bun's `fetch` cannot bound the connect phase or the gap between
 * response chunks, so requests with connect/read timeouts go through `node:http(s)` instead.
 * Redirects are not followed and a fresh connection is used per request.
 */
export function timedRequest(uri: string, init: TimedInit, timeouts: TransportTimeouts): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const url = new URL(uri);
    const secure = url.protocol === 'https:';
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    // fetch decompresses transparently; a raw socket would not.
    if (headers['accept-encoding'] === undefined) headers['accept-encoding'] = 'identity';
    const body = typeof init.body === 'string' ? init.body : undefined;
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));

    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;

    const clearTimers = (): void => {
      clearTimeout(connectTimer);
      clearTimeout(readTimer);
    };
    const armRead = (): void => {
      if (timeouts.readTimeout === undefined) return;
      clearTimeout(readTimer);
      readTimer = setTimeout(() => abort(new TimeoutError('Read timed out')), timeouts.readTimeout);
    };
    const abort = (error: Error): void => {
      if (finished) return;
      finished = true;
      clearTimers();
      req.destroy();
      if (bodyController) bodyController.error(error);
      else reject(error);
    };

    const req = (secure ? https : http).request(url, {
      method, headers, agent: false, ...(secure ? init.tls : {}),
    });

    if (timeouts.connectTimeout !== undefined) {
      connectTimer = setTimeout(() => abort(new ConnectionError('Connection timed out')), timeouts.connectTimeout);
    }
    req.on('socket', socket => {
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        clearTimeout(connectTimer);
        armRead();
      });
    });
    req.on('error', error => abort(error));
    req.on('response', res => {
      armRead();
      const responseHeaders = new Headers();
      for (let index = 0; index < res.rawHeaders.length; index += 2) {
        try { responseHeaders.append(res.rawHeaders[index]!, res.rawHeaders[index + 1]!); } catch { /* skip invalid header */ }
      }
      const status = res.statusCode ?? 502;
      if (BODYLESS_STATUSES.has(status) || method === 'HEAD') {
        finished = true;
        clearTimers();
        res.resume();
        resolve(new Response(null, { status, statusText: res.statusMessage, headers: responseHeaders }));
        return;
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          res.on('data', (chunk: Buffer) => {
            armRead();
            controller.enqueue(new Uint8Array(chunk));
          });
          res.on('end', () => {
            if (finished) return;
            finished = true;
            clearTimers();
            controller.close();
          });
          res.on('error', error => abort(error));
        },
        cancel() {
          finished = true;
          clearTimers();
          req.destroy();
        },
      });
      resolve(new Response(stream, { status, statusText: res.statusMessage, headers: responseHeaders }));
    });

    const signal = init.signal;
    if (signal) {
      if (signal.aborted) { abort(new Error('aborted')); return; }
      signal.addEventListener('abort', () => abort(new Error('aborted')), { once: true });
    }
    req.end(body);
  });
}
