import { Hono } from 'hono';
import type { BackendConfig, RoutingRule } from '../config.js';
import {
  getConfig, updateBackend, deleteBackend, updateRouting,
} from '../config-store.js';

export function createAdminApi(): Hono {
  const app = new Hono();

  // ── GET /admin/api/config ── full config (sans sensitive keys displayed in full)
  app.get('/api/config', (c) => {
    const config = getConfig();
    return c.json({
      backends: Object.fromEntries(
        Object.entries(config.backends).map(([name, b]) => [name, {
          ...b,
          apiKey: b.apiKey ? maskKey(b.apiKey) : undefined,
        }]),
      ),
      routing: config.routing,
    });
  });

  // ── GET /admin/api/backends ── list backends
  app.get('/api/backends', (c) => {
    const config = getConfig();
    return c.json(Object.fromEntries(
      Object.entries(config.backends).map(([name, b]) => [name, {
        ...b,
        apiKey: b.apiKey ? maskKey(b.apiKey) : undefined,
      }]),
    ));
  });

  // ── PUT /admin/api/backends/:name ── create or update a backend
  app.put('/api/backends/:name', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json<Partial<BackendConfig> & { apiKey?: string }>();

    if (!body.url) {
      return c.json({ error: 'url is required' }, 400);
    }

    // If apiKey is masked or empty, preserve existing
    const existing = getConfig().backends[name];
    const apiKey = (!body.apiKey || body.apiKey.includes('***'))
      ? existing?.apiKey
      : body.apiKey;

    const backend: BackendConfig = {
      url: body.url,
      apiKey,
      apiMode: body.apiMode,
      optimize: body.optimize,
      providerPreferences: body.providerPreferences,
    };

    updateBackend(name, backend);
    return c.json({ ok: true, name, backend: { ...backend, apiKey: apiKey ? maskKey(apiKey) : undefined } });
  });

  // ── DELETE /admin/api/backends/:name ── remove a backend
  app.delete('/api/backends/:name', (c) => {
    const name = c.req.param('name');
    if (name === 'anthropic') {
      return c.json({ error: 'Cannot delete the anthropic backend' }, 400);
    }
    deleteBackend(name);
    return c.json({ ok: true });
  });

  // ── GET /admin/api/routing ── get routing rules
  app.get('/api/routing', (c) => {
    return c.json(getConfig().routing.rules);
  });

  // ── PUT /admin/api/routing ── replace all routing rules
  app.put('/api/routing', async (c) => {
    const rules = await c.req.json<RoutingRule[]>();
    if (!Array.isArray(rules)) {
      return c.json({ error: 'Expected an array of routing rules' }, 400);
    }
    for (const rule of rules) {
      if (!rule.match || !rule.backend) {
        return c.json({ error: 'Each rule needs match and backend' }, 400);
      }
    }
    updateRouting(rules);
    return c.json({ ok: true, rules });
  });

  // ── GET /admin/api/status ── health + overview
  app.get('/api/status', (c) => {
    const config = getConfig();
    return c.json({
      backends: Object.keys(config.backends),
      rulesCount: config.routing.rules.length,
      auth: config.auth.enabled,
    });
  });

  return app;
}

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}
