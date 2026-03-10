import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export interface BackendConfig {
  url: string;
  apiKey?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

export interface RoutingRule {
  match: string;
  backend: string;
}

export interface LoggingConfig {
  level: 'minimal' | 'standard' | 'verbose';
}

export interface AuthConfig {
  enabled: boolean;
  cacheTtlMinutes: number;
}

export interface Config {
  server: { port: number; host: string };
  auth: AuthConfig;
  backends: Record<string, BackendConfig>;
  routing: { rules: RoutingRule[] };
  logging: LoggingConfig;
}

const DEFAULT_CONFIG: Config = {
  server: { port: 4000, host: '0.0.0.0' },
  auth: { enabled: true, cacheTtlMinutes: 60 },
  backends: {
    anthropic: { url: 'https://api.anthropic.com' },
    lmstudio: { url: 'http://localhost:1234' },
  },
  routing: {
    rules: [
      { match: 'claude-*', backend: 'anthropic' },
      { match: '*', backend: 'lmstudio' },
    ],
  },
  logging: { level: 'standard' },
};

export function loadConfig(configPath?: string): Config {
  if (!configPath) {
    const tryPath = resolve(process.cwd(), 'modelgate.config.yaml');
    try {
      readFileSync(tryPath, 'utf-8');
      configPath = tryPath;
    } catch {
      return applyEnvOverrides(DEFAULT_CONFIG);
    }
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parse(raw) as Partial<Config>;

  const config: Config = {
    server: { ...DEFAULT_CONFIG.server, ...parsed.server },
    auth: { ...DEFAULT_CONFIG.auth, ...parsed.auth },
    backends: { ...DEFAULT_CONFIG.backends, ...parsed.backends },
    routing: parsed.routing ?? DEFAULT_CONFIG.routing,
    logging: { ...DEFAULT_CONFIG.logging, ...parsed.logging },
  };

  return applyEnvOverrides(config);
}

function applyEnvOverrides(config: Config): Config {
  if (process.env.ANTHROPIC_API_KEY && config.backends.anthropic) {
    config.backends.anthropic.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.PORT) {
    config.server.port = parseInt(process.env.PORT, 10);
  }
  if (process.env.CF_ACCESS_CLIENT_ID && config.backends.lmstudio) {
    config.backends.lmstudio.cfAccessClientId = process.env.CF_ACCESS_CLIENT_ID;
  }
  if (process.env.CF_ACCESS_CLIENT_SECRET && config.backends.lmstudio) {
    config.backends.lmstudio.cfAccessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  return config;
}
