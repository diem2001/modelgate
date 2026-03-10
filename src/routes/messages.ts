import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { AnthropicRequest } from '../types.js';
import { resolveBackend } from '../router.js';
import { forwardToAnthropic } from '../backends/anthropic.js';
import { forwardToOllama } from '../backends/ollama.js';
import { logRequest, logResponse, logStreamStart, logStreamEnd, logError } from '../logger.js';

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

    logRequest(body, backend.backendName);
    const startTime = Date.now();

    try {
      let upstreamRes: Response;

      if (backend.backendName === 'anthropic') {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(c.req.header())) {
          if (typeof value === 'string') headers[key] = value;
        }
        if (!headers['authorization'] && !headers['x-api-key'] && !backend.apiKey) {
          return c.json({ type: 'error', error: { type: 'authentication_error', message: 'No authentication provided (send Authorization or x-api-key header)' } }, 401);
        }
        upstreamRes = await forwardToAnthropic(body, backend.url, backend.apiKey, headers);
      } else {
        upstreamRes = await forwardToOllama(body, backend.url);
      }

      const responseHeaders = new Headers();
      const contentType = upstreamRes.headers.get('content-type');
      if (contentType) responseHeaders.set('content-type', contentType);

      if (body.stream) {
        logStreamStart(body.model, backend.backendName);
        // Wrap the stream to log when it completes
        const originalBody = upstreamRes.body;
        if (originalBody) {
          const reader = originalBody.getReader();
          const stream = new ReadableStream({
            async pull(controller) {
              const { done, value } = await reader.read();
              if (done) {
                logStreamEnd(body.model, backend.backendName, Date.now() - startTime);
                controller.close();
              } else {
                controller.enqueue(value);
              }
            },
            cancel() {
              reader.cancel();
            },
          });
          return new Response(stream, { status: upstreamRes.status, headers: responseHeaders });
        }
      }

      logResponse(body.model, backend.backendName, upstreamRes.status, Date.now() - startTime);

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    } catch (err) {
      logError(body.model, backend.backendName, err as Error);
      return c.json({
        type: 'error',
        error: { type: 'api_error', message: `Backend error: ${(err as Error).message}` },
      }, 502);
    }
  });

  return app;
}
