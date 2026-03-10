import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { initConfigStore, getConfig } from './config-store.js';
import { createMessagesRoute } from './routes/messages.js';
import { createAdminApi } from './routes/admin-api.js';
import { initLogger } from './logger.js';
import { extractToken, validateToken } from './auth.js';

const configPath = process.argv[2];
const baseConfig = loadConfig(configPath);

// Initialize config store (merges base config with persistent data/config.yaml)
initConfigStore(baseConfig);

initLogger(baseConfig.logging);

const app = new Hono();

// Health check (no auth)
app.get('/health', (c) => c.json({ status: 'ok', version: '0.2.0' }));

// Admin panel — static files (no auth, internal use only)
app.get('/admin', (c) => c.redirect('/admin/'));
app.use('/admin/*', serveStatic({ root: './', rewriteRequestPath: (path) => path.replace('/admin/', '/admin/') }));

// Admin API (no auth, internal use only)
app.route('/admin', createAdminApi());

// Auth middleware for all /v1/* routes
app.use('/v1/*', async (c, next) => {
  const config = getConfig();
  if (!config.auth.enabled) return next();

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(c.req.header())) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
  }

  const token = extractToken(headers);
  if (!token) {
    return c.json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Missing authentication (send Authorization: Bearer <token> or x-api-key header)' },
    }, 401);
  }

  const valid = await validateToken(token, baseConfig.auth);
  if (!valid) {
    return c.json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid authentication token' },
    }, 401);
  }

  return next();
});

// Model listing
app.get('/v1/models', (c) => {
  const config = getConfig();
  return c.json({
    backends: Object.keys(config.backends),
    rules: config.routing.rules,
  });
});

// Anthropic Messages API — uses live config from ConfigStore
app.route('/', createMessagesRoute());

const config = getConfig();
console.log(`
  ╔══════════════════════════════════════╗
  ║          M O D E L G A T E          ║
  ║   Anthropic-compatible LLM Proxy    ║
  ╚══════════════════════════════════════╝

  Listening on http://${config.server.host}:${config.server.port}
  Admin:    http://${config.server.host}:${config.server.port}/admin/

  Auth: ${config.auth.enabled ? `enabled (cache TTL: ${config.auth.cacheTtlMinutes}min)` : 'disabled'}

  Backends:`);

for (const [name, backend] of Object.entries(config.backends)) {
  console.log(`    ${name}: ${backend.url}`);
}

console.log(`\n  Routing rules:`);
for (const rule of config.routing.rules) {
  const model = rule.model ? ` (→ ${rule.model})` : '';
  console.log(`    ${rule.match} → ${rule.backend}${model}`);
}
console.log('');

serve({
  fetch: app.fetch,
  port: config.server.port,
  hostname: config.server.host,
});
