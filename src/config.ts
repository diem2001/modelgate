import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export interface BackendConfig {
  url: string;
  apiKey?: string;
}

export interface RoutingRule {
  match: string;
  backend: string;
}

export interface Config {
  server: { port: number; host: string };
  backends: Record<string, BackendConfig>;
  routing: { rules: RoutingRule[] };
}

const DEFAULT_CONFIG: Config = {
  server: { port: 4000, host: '0.0.0.0' },
  backends: {
    anthropic: { url: 'https://api.anthropic.com' },
    ollama: { url: 'http://localhost:11434' },
  },
  routing: {
    rules: [
      { match: 'claude-*', backend: 'anthropic' },
      { match: '*', backend: 'ollama' },
    ],
  },
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
    backends: { ...DEFAULT_CONFIG.backends, ...parsed.backends },
    routing: parsed.routing ?? DEFAULT_CONFIG.routing,
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
  return config;
}
