import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = fileURLToPath(new URL('../..', import.meta.url));

function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop();
  return port;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // server not up yet
    }
    await Bun.sleep(50);
  }
  return false;
}

it('flushes queued execution records before exiting on SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apiconfy-shutdown-'));
  const dbPath = join(dir, 'shutdown.db');
  const port = freePort();
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: `sqlite:${dbPath}`,
    LOG_LEVEL: 'silent',
  };
  delete env.API_KEY;
  delete env.REQUIRE_API_KEY;
  const proc = Bun.spawn([Bun.which('bun') ?? 'bun', 'run', 'src/index.ts'], {
    cwd: serverDir,
    env,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    expect(await waitForHealth(`http://127.0.0.1:${port}/health`, 15_000)).toBe(true);

    const registered = await fetch(`http://127.0.0.1:${port}/api/v1/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: 'self',
        action: 'ping',
        componentType: 'rest',
        config: { request: { uri: `http://127.0.0.1:${port}/health`, method: 'GET' } },
      }),
    });
    expect(registered.status).toBe(201);

    const invoked = await fetch(`http://127.0.0.1:${port}/api/v1/services/self/ping/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const executionId = invoked.headers.get('execution-id')!;

    // Terminate right after the response: the record is still queued here. The second signal
    // must be ignored by the shutdown guard instead of starting a second shutdown.
    proc.kill('SIGTERM');
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);

    const db = new Database(dbPath);
    expect(db.query('select execution_id from executions').all()).toEqual([{ execution_id: executionId }]);
    expect(db.query('select execution_id from execution_logs').all()).toEqual([{ execution_id: executionId }]);
    db.close();
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
