import { afterEach, describe, expect, it } from 'bun:test';
import net from 'node:net';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { timedRequest } from '@/core/components/rest/timed-transport.js';
import { ConnectionError, TimeoutError } from '@/lib/errors.js';

const servers: Array<net.Server | http.Server> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen<T extends net.Server | http.Server>(server: T): Promise<{ server: T; port: number }> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

describe('timedRequest', () => {
  it('returns status, headers and body', async () => {
    const { port } = await listen(http.createServer((req, res) => {
      let received = '';
      req.on('data', chunk => { received += chunk; });
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echoed: received }));
      });
    }));
    const res = await timedRequest(`http://127.0.0.1:${port}/x`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}',
    }, { connectTimeout: 1000, readTimeout: 1000 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ echoed: '{"a":1}' });
  });

  it('fails with ConnectionError when the TLS handshake never completes within connectTimeout', async () => {
    const { port } = await listen(net.createServer(() => {}));
    const started = Date.now();
    await expect(timedRequest(`https://127.0.0.1:${port}/`, {}, { connectTimeout: 100, readTimeout: 5000 }))
      .rejects.toBeInstanceOf(ConnectionError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('fails with TimeoutError when no response data arrives within readTimeout', async () => {
    const { port } = await listen(http.createServer(() => {}));
    await expect(timedRequest(`http://127.0.0.1:${port}/`, {}, { connectTimeout: 1000, readTimeout: 100 }))
      .rejects.toBeInstanceOf(TimeoutError);
  });

  it('errors the body stream when the response stalls mid-body', async () => {
    const { port } = await listen(http.createServer((_req, res) => {
      res.writeHead(200);
      res.write('partial');
    }));
    const res = await timedRequest(`http://127.0.0.1:${port}/`, {}, { readTimeout: 100 });
    await expect(res.text()).rejects.toBeInstanceOf(TimeoutError);
  });

  it('does not time out while chunks keep arriving within readTimeout', async () => {
    const { port } = await listen(http.createServer((_req, res) => {
      res.writeHead(200);
      let count = 0;
      const timer = setInterval(() => {
        res.write('x');
        count += 1;
        if (count === 5) { clearInterval(timer); res.end(); }
      }, 50);
    }));
    const res = await timedRequest(`http://127.0.0.1:${port}/`, {}, { readTimeout: 200 });
    expect(await res.text()).toBe('xxxxx');
  });

  it('aborts when the caller signal fires', async () => {
    const { port } = await listen(http.createServer(() => {}));
    const controller = new AbortController();
    const pending = timedRequest(`http://127.0.0.1:${port}/`, { signal: controller.signal }, {});
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
  });
});
