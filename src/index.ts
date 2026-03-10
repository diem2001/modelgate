import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { createMessagesRoute } from './routes/messages.js';
import { initLogger } from './logger.js';

const configPath = process.argv[2];
const config = loadConfig(configPath);

initLogger(config.logging);

const app = new Hono();

// Health check
app.get('/health', (c) => c.json({ status: 'ok', version: '0.1.0' }));

// Model routing info
app.get('/v1/models', (c) => {
  return c.json({
    backends: Object.keys(config.backends),
    rules: config.routing.rules,
  });
});

// Anthropic Messages API
app.route('/', createMessagesRoute(config));

console.log(`
  ╔══════════════════════════════════════╗
  ║          M O D E L G A T E          ║
  ║   Anthropic-compatible LLM Proxy    ║
  ╚══════════════════════════════════════╝

  Listening on http://${config.server.host}:${config.server.port}

  Backends:`);

for (const [name, backend] of Object.entries(config.backends)) {
  console.log(`    ${name}: ${backend.url}`);
}

console.log(`\n  Routing rules:`);
for (const rule of config.routing.rules) {
  console.log(`    ${rule.match} → ${rule.backend}`);
}
console.log('');

serve({
  fetch: app.fetch,
  port: config.server.port,
  hostname: config.server.host,
});
