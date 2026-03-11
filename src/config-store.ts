import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Config, BackendConfig, RoutingRule, AuthConfig } from './config.js';

const DATA_DIR = resolve(process.cwd(), 'data');
const CONFIG_FILE = resolve(DATA_DIR, 'config.yaml');

let current: Config | null = null;

/** Ensure data directory exists */
function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Load config from data/config.yaml (or return null if not found) */
function loadFromDisk(): Config | null {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return parse(raw) as Config;
  } catch {
    return null;
  }
}

/** Save config to data/config.yaml */
function saveToDisk(config: Config) {
  ensureDataDir();
  // Persist backends, routing, and auth cache TTL — server/logging stay in static config
  const persistable: Record<string, unknown> = {
    backends: config.backends,
    routing: config.routing,
    auth: {
      cacheTtlMinutes: config.auth.cacheTtlMinutes,
      ...(config.auth.allowedOrgIds?.length ? { allowedOrgIds: config.auth.allowedOrgIds } : {}),
    },
  };
  writeFileSync(CONFIG_FILE, stringify(persistable, { lineWidth: 120 }), 'utf-8');
}

/** Initialize the store with the base config from loadConfig() */
export function initConfigStore(baseConfig: Config) {
  const stored = loadFromDisk();
  if (stored) {
    // Merge: stored backends/routing override base, but keep server/auth/logging from base
    // Per-backend deep merge so env overrides (e.g. LMSTUDIO_API_KEY) are preserved
    const mergedBackends: Record<string, BackendConfig> = { ...baseConfig.backends };
    for (const [name, storedBackend] of Object.entries(stored.backends ?? {})) {
      mergedBackends[name] = { ...baseConfig.backends[name], ...storedBackend };
    }
    current = {
      ...baseConfig,
      backends: mergedBackends,
      routing: stored.routing ?? baseConfig.routing,
      auth: {
        ...baseConfig.auth,
        ...(stored.auth?.cacheTtlMinutes ? { cacheTtlMinutes: stored.auth.cacheTtlMinutes } : {}),
        ...(stored.auth?.allowedOrgIds ? { allowedOrgIds: stored.auth.allowedOrgIds } : {}),
      },
    };
  } else {
    current = baseConfig;
    saveToDisk(current);
  }
}

/** Get the current live config */
export function getConfig(): Config {
  if (!current) throw new Error('ConfigStore not initialized');
  return current;
}

/** Update backends */
export function updateBackends(backends: Record<string, BackendConfig>) {
  if (!current) throw new Error('ConfigStore not initialized');
  current.backends = backends;
  saveToDisk(current);
}

/** Update a single backend */
export function updateBackend(name: string, backend: BackendConfig) {
  if (!current) throw new Error('ConfigStore not initialized');
  current.backends[name] = backend;
  saveToDisk(current);
}

/** Delete a backend */
export function deleteBackend(name: string) {
  if (!current) throw new Error('ConfigStore not initialized');
  delete current.backends[name];
  // Also remove routing rules that reference this backend
  current.routing.rules = current.routing.rules.filter(r => r.backend !== name);
  saveToDisk(current);
}

/** Update routing rules */
export function updateRouting(rules: RoutingRule[]) {
  if (!current) throw new Error('ConfigStore not initialized');
  current.routing.rules = rules;
  saveToDisk(current);
}

/** Update auth settings */
export function updateAuth(auth: Partial<AuthConfig>) {
  if (!current) throw new Error('ConfigStore not initialized');
  if (auth.cacheTtlMinutes !== undefined) {
    current.auth.cacheTtlMinutes = auth.cacheTtlMinutes;
  }
  if (auth.allowedOrgIds !== undefined) {
    current.auth.allowedOrgIds = auth.allowedOrgIds.length > 0 ? auth.allowedOrgIds : undefined;
  }
  saveToDisk(current);
}

/** Get the data directory path */
export function getDataDir(): string {
  return DATA_DIR;
}
