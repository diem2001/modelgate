import type { Config, RoutingRule } from './config.js';

function matchesPattern(model: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return model.startsWith(pattern.slice(0, -1));
  }
  return model === pattern;
}

export function resolveBackend(model: string, config: Config): { backendName: string; url: string; apiKey?: string } {
  for (const rule of config.routing.rules) {
    if (matchesPattern(model, rule.match)) {
      const backend = config.backends[rule.backend];
      if (!backend) throw new Error(`Backend "${rule.backend}" not found in config`);
      return { backendName: rule.backend, url: backend.url, apiKey: backend.apiKey };
    }
  }
  throw new Error(`No routing rule matched model "${model}"`);
}
