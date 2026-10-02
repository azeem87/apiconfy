import { createHash } from 'node:crypto';
import type { SSLConfig } from '@/core/types.js';
import { buildTlsOptions } from '@/core/components/rest/tls.js';
import { parseResponseBody } from '@/lib/http.js';
import { AppError, ConnectionError, ExternalServiceError } from '@/lib/errors.js';

export interface AuthMaterial {
  name: string;
  value: string;
}

interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  accessTokenUri: string;
  scope?: string;
  clientAuth?: 'basic' | 'body';
  audience?: string;
}

export interface AuthBlock {
  ssl?: SSLConfig;
  basic?: { username: string; password: string };
  oauth2?: OAuth2Config;
  jwt?: unknown;
}

// RFC 6749 §2.3.1 / Appendix B: id and secret are form-urlencoded before base64.
const formEncode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');
const basicHeader = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;

/**
 * Resolves `request.auth` into a header. Config arrives with `{$env}` references already
 * resolved. Tokens are cached in memory until a 401 invalidates them — no TTL, `expires_in` unused.
 */
export class AuthRuntime {
  private readonly tokens = new Map<string, Promise<string>>();

  constructor(private readonly httpRequest: typeof fetch = globalThis.fetch) {}

  /** Only an oauth2 token can be replaced by a replay; basic is static. */
  canReplay(auth: AuthBlock): boolean {
    return auth.oauth2 !== undefined;
  }

  async resolve(auth: AuthBlock, signal: AbortSignal, onSecret: (secret: string) => void): Promise<AuthMaterial> {
    if (auth.basic) {
      const value = basicHeader(formEncode(auth.basic.username), formEncode(auth.basic.password));
      onSecret(value);
      return { name: 'Authorization', value };
    }
    if (auth.oauth2) {
      const token = await this.oauth2Token(auth.oauth2, auth.ssl, signal);
      onSecret(token);
      return { name: 'Authorization', value: `Bearer ${token}` };
    }
    throw new AppError('Unsupported auth block', 'NOT_IMPLEMENTED', 501);
  }

  invalidate(auth: AuthBlock): void {
    if (auth.oauth2) this.tokens.delete(this.cacheKey(auth.oauth2));
  }

  private cacheKey(config: OAuth2Config): string {
    const { clientId, clientSecret, accessTokenUri, scope, clientAuth, audience } = config;
    return createHash('sha256')
      .update(JSON.stringify([clientId, clientSecret, accessTokenUri, scope ?? '', clientAuth ?? 'basic', audience ?? '']))
      .digest('hex');
  }

  private oauth2Token(config: OAuth2Config, ssl: SSLConfig | undefined, signal: AbortSignal): Promise<string> {
    const key = this.cacheKey(config);
    const cached = this.tokens.get(key);
    if (cached) return cached;
    // Single-flight: concurrent first calls share one token request.
    const pending = this.fetchOAuth2Token(config, ssl, signal);
    this.tokens.set(key, pending);
    pending.catch(() => { if (this.tokens.get(key) === pending) this.tokens.delete(key); });
    return pending;
  }

  private async fetchOAuth2Token(config: OAuth2Config, ssl: SSLConfig | undefined, signal: AbortSignal): Promise<string> {
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (config.clientAuth === 'body') {
      form.set('client_id', config.clientId);
      form.set('client_secret', config.clientSecret);
    } else {
      headers.set('Authorization', basicHeader(formEncode(config.clientId), formEncode(config.clientSecret)));
    }
    if (config.scope) form.set('scope', config.scope);
    if (config.audience) form.set('audience', config.audience);

    const tls = buildTlsOptions(ssl);
    let response: Response;
    try {
      response = await this.httpRequest(config.accessTokenUri, {
        method: 'POST', headers, body: form.toString(), signal, ...(tls ? { tls } : {}),
      } as RequestInit);
    } catch {
      throw new ConnectionError('Failed to reach the token endpoint');
    }
    if (!response.ok) {
      throw new ExternalServiceError(`Token endpoint returned ${response.status}`, response.status);
    }
    let body: unknown;
    try {
      body = await parseResponseBody(response);
    } catch {
      body = null;
    }
    const token = (body as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== 'string' || token === '') {
      throw new ExternalServiceError('Token endpoint response has no access_token', response.status);
    }
    return token;
  }
}
