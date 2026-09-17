import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { authPostureProblem, loadConfig, type AppConfig } from '@/config.js';
import { securityHeaders } from '@/middleware/security-headers.js';

const ORIGINAL_ENV = { ...process.env };
const TOUCHED = ['PORT', 'LOG_LEVEL', 'API_KEY', 'REQUIRE_API_KEY'];

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const key of TOUCHED) {
      const original = ORIGINAL_ENV[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

describe('loadConfig', () => {
  it('defaults port, log level, and treats an absent API_KEY as not-strict', () => {
    withEnv({ PORT: undefined, LOG_LEVEL: undefined, API_KEY: undefined, REQUIRE_API_KEY: undefined }, () => {
      expect(loadConfig()).toEqual({
        port: 3000, logLevel: 'info', apiKey: undefined, requireApiKey: false,
      });
    });
  });

  it('reads PORT, LOG_LEVEL, API_KEY and REQUIRE_API_KEY', () => {
    withEnv({ PORT: '4321', LOG_LEVEL: 'debug', API_KEY: 'k', REQUIRE_API_KEY: 'true' }, () => {
      expect(loadConfig()).toEqual({
        port: 4321, logLevel: 'debug', apiKey: 'k', requireApiKey: true,
      });
    });
  });

  it('treats REQUIRE_API_KEY=1 as strict too', () => {
    withEnv({ REQUIRE_API_KEY: '1' }, () => {
      expect(loadConfig().requireApiKey).toBe(true);
    });
  });

  it.each(['TRUE', 'yes', '0', ''])('does not treat REQUIRE_API_KEY=%s as strict', (value) => {
    withEnv({ REQUIRE_API_KEY: value }, () => {
      expect(loadConfig().requireApiKey).toBe(false);
    });
  });
});

describe('authPostureProblem', () => {
  const base: AppConfig = { port: 3000, logLevel: 'info' };

  it('is nil when a key is configured', () => {
    expect(authPostureProblem({ ...base, apiKey: 'k', requireApiKey: true })).toBeNull();
  });

  it('is nil by default — a missing key is only a warning', () => {
    expect(authPostureProblem(base)).toBeNull();
    expect(authPostureProblem({ ...base, requireApiKey: false })).toBeNull();
  });

  it('is set when REQUIRE_API_KEY is on and API_KEY is missing', () => {
    expect(authPostureProblem({ ...base, requireApiKey: true })).toContain('REQUIRE_API_KEY');
  });
});

describe('security headers', () => {
  it('sets the hardening headers on every response, and no CORS headers', async () => {
    const app = new Hono();
    app.use('*', securityHeaders);
    app.get('/probe', (c) => c.json({ ok: true }));

    const response = await app.request('/probe');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
