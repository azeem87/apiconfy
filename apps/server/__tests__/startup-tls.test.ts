import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('the real entrypoint ignores NODE_TLS_REJECT_UNAUTHORIZED=0 and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apiconfy-startup-'));
  const child = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', PORT: '0', LOG_LEVEL: 'info',
      SQLITE_PATH: join(dir, 'test.db'), DATABASE_URL: '', API_KEY: 'startup-test-key',
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    let output = '';
    const reader = child.stdout.getReader();
    const deadline = Date.now() + 15_000;
    while (!output.includes('Server ready') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    expect(output).toContain('NODE_TLS_REJECT_UNAUTHORIZED=0 was set in the environment and has been ignored');
    expect(output).toContain('Server ready');
  } finally {
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
