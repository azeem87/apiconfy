export interface AppConfig {
  port: number;
  logLevel: string;
  apiKey?: string;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    apiKey: process.env.API_KEY,
  };
}
