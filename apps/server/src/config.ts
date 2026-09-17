export interface AppConfig {
  port: number;
  logLevel: string;
  apiKey?: string;
  /** When true a missing `API_KEY` is fatal instead of a warning (security-review-phase2.md A1). */
  requireApiKey?: boolean;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    apiKey: process.env.API_KEY,
    requireApiKey: process.env.REQUIRE_API_KEY === 'true' || process.env.REQUIRE_API_KEY === '1',
  };
}

/**
 * The default posture stays fail-open with a loud warning, because local development should not
 * require a key. `REQUIRE_API_KEY=true` converts that into a refused startup for deployments.
 */
export function authPostureProblem(config: AppConfig): string | null {
  if (config.apiKey || !config.requireApiKey) return null;
  return 'REQUIRE_API_KEY is set but API_KEY is missing — refusing to start with every /api/* '
    + 'route open (security-review-phase2.md A1).';
}
