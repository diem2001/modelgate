import { Hono } from 'hono';
import type { BackendConfig, RoutingRule } from '../config.js';
import {
  getConfig, updateBackend, deleteBackend, updateRouting, updateAuth,
} from '../config-store.js';

function sanitizeBackend(b: BackendConfig): Record<string, unknown> {
  const { apiKey, ...rest } = b;
  return { ...rest, hasApiKey: !!apiKey };
}

export function createAdminApi(): Hono {
  const app = new Hono();

  // ── GET /admin/api/config ── full config (no secret values)
  app.get('/api/config', (c) => {
    const config = getConfig();
    return c.json({
      backends: Object.fromEntries(
        Object.entries(config.backends).map(([name, b]) => [name, sanitizeBackend(b)]),
      ),
      routing: config.routing,
    });
  });

  // ── GET /admin/api/backends ── list backends
  app.get('/api/backends', (c) => {
    const config = getConfig();
    return c.json(Object.fromEntries(
      Object.entries(config.backends).map(([name, b]) => [name, sanitizeBackend(b)]),
    ));
  });

  // ── PUT /admin/api/backends/:name ── create or update a backend
  app.put('/api/backends/:name', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json<Partial<BackendConfig> & { apiKey?: string; clearApiKey?: boolean }>();

    if (!body.url) {
      return c.json({ error: 'url is required' }, 400);
    }

    const existing = getConfig().backends[name];
    let apiKey: string | undefined;
    if (body.clearApiKey) {
      apiKey = undefined; // explicitly remove
    } else if (body.apiKey) {
      apiKey = body.apiKey; // new key provided
    } else {
      apiKey = existing?.apiKey; // preserve existing
    }

    const backend: BackendConfig = {
      url: body.url,
      apiKey,
      apiMode: body.apiMode,
      optimize: body.optimize,
      providerPreferences: body.providerPreferences,
    };

    updateBackend(name, backend);
    return c.json({ ok: true, name, backend: sanitizeBackend(backend) });
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

  // ── GET /admin/api/auth ── get auth settings
  app.get('/api/auth', (c) => {
    const config = getConfig();
    return c.json({
      enabled: config.auth.enabled,
      cacheTtlMinutes: config.auth.cacheTtlMinutes,
      allowedOrgIds: config.auth.allowedOrgIds ?? [],
    });
  });

  // ── PUT /admin/api/auth ── update auth settings
  app.put('/api/auth', async (c) => {
    const body = await c.req.json<{ cacheTtlMinutes?: number; allowedOrgIds?: string[] }>();
    const updates: Partial<{ cacheTtlMinutes: number; allowedOrgIds: string[] }> = {};

    if (body.cacheTtlMinutes !== undefined) {
      const ttl = Number(body.cacheTtlMinutes);
      if (isNaN(ttl) || ttl < 1) {
        return c.json({ error: 'cacheTtlMinutes must be a number >= 1' }, 400);
      }
      updates.cacheTtlMinutes = ttl;
    }

    if (body.allowedOrgIds !== undefined) {
      if (!Array.isArray(body.allowedOrgIds)) {
        return c.json({ error: 'allowedOrgIds must be an array of strings' }, 400);
      }
      updates.allowedOrgIds = body.allowedOrgIds.filter(id => typeof id === 'string' && id.trim().length > 0).map(id => id.trim());
    }

    if (Object.keys(updates).length > 0) {
      updateAuth(updates);
    }

    const config = getConfig();
    return c.json({
      ok: true,
      auth: {
        enabled: config.auth.enabled,
        cacheTtlMinutes: config.auth.cacheTtlMinutes,
        allowedOrgIds: config.auth.allowedOrgIds ?? [],
      },
    });
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

