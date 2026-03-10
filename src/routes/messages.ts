import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { AnthropicRequest } from '../types.js';
import { resolveBackend } from '../router.js';
import { forwardToAnthropic } from '../backends/anthropic.js';
import { forwardToOllama } from '../backends/ollama.js';

export function createMessagesRoute(config: Config): Hono {
  const app = new Hono();

  app.post('/v1/messages', async (c) => {
    let body: AnthropicRequest;
    try {
      body = await c.req.json<AnthropicRequest>();
    } catch {
      return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }, 400);
    }

    if (!body.model) {
      return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Missing required field: model' } }, 400);
    }
    if (!body.max_tokens) {
      return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Missing required field: max_tokens' } }, 400);
    }

    let backend: ReturnType<typeof resolveBackend>;
    try {
      backend = resolveBackend(body.model, config);
    } catch (err) {
      return c.json({ type: 'error', error: { type: 'invalid_request_error', message: (err as Error).message } }, 400);
    }

    const logPrefix = `[${body.model} → ${backend.backendName}]`;
    console.log(`${logPrefix} ${body.stream ? 'stream' : 'sync'} | ${body.messages.length} messages | max_tokens=${body.max_tokens}`);

    try {
      let upstreamRes: Response;

      if (backend.backendName === 'anthropic') {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(c.req.header())) {
          if (typeof value === 'string') headers[key] = value;
        }
        // Auth is passed through from client (OAuth Bearer or API key)
        if (!headers['authorization'] && !headers['x-api-key'] && !backend.apiKey) {
          return c.json({ type: 'error', error: { type: 'authentication_error', message: 'No authentication provided (send Authorization or x-api-key header)' } }, 401);
        }
        upstreamRes = await forwardToAnthropic(body, backend.url, backend.apiKey, headers);
      } else {
        upstreamRes = await forwardToOllama(body, backend.url);
      }

      // Pass through the response
      const responseHeaders = new Headers();
      const contentType = upstreamRes.headers.get('content-type');
      if (contentType) responseHeaders.set('content-type', contentType);

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    } catch (err) {
      console.error(`${logPrefix} Error:`, err);
      return c.json({
        type: 'error',
        error: { type: 'api_error', message: `Backend error: ${(err as Error).message}` },
      }, 502);
    }
  });

  return app;
}
