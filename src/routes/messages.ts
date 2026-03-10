import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { AnthropicRequest, AnthropicResponse } from '../types.js';
import { resolveBackend } from '../router.js';
import { forwardToAnthropic } from '../backends/anthropic.js';
import { forwardToOpenAICompat } from '../backends/openai-compat.js';
import {
  logRequest, logResponseSync, logStreamStart, logStreamResponse,
  logResponseError, logError,
} from '../logger.js';

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

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(c.req.header())) {
        if (typeof value === 'string') headers[key] = value;
      }

      if (backend.backendName === 'anthropic') {
        if (!headers['authorization'] && !headers['x-api-key'] && !backend.apiKey) {
          return c.json({ type: 'error', error: { type: 'authentication_error', message: 'No authentication provided (send Authorization or x-api-key header)' } }, 401);
        }
        upstreamRes = await forwardToAnthropic(body, backend.url, backend.apiKey, headers);
      } else {
        const backendConfig = config.backends[backend.backendName];
        upstreamRes = await forwardToOpenAICompat(
          body, backend.url, backendConfig?.cfAccessClientId, backendConfig?.cfAccessClientSecret,
        );
      }

      const responseHeaders = new Headers();
      const contentType = upstreamRes.headers.get('content-type');
      if (contentType) responseHeaders.set('content-type', contentType);

      // Streaming response
      if (body.stream && upstreamRes.body) {
        logStreamStart(body.model, backend.backendName);
        return createLoggingStream(upstreamRes, responseHeaders, body.model, backend.backendName, startTime);
      }

      // Sync response
      const responseBody = await upstreamRes.text();
      let content: AnthropicResponse['content'] | undefined;
      try {
        const parsed = JSON.parse(responseBody) as AnthropicResponse;
        content = parsed.content;
      } catch { /* not JSON */ }

      if (upstreamRes.status >= 200 && upstreamRes.status < 300) {
        logResponseSync(body.model, backend.backendName, upstreamRes.status, Date.now() - startTime, content);
      } else {
        logResponseError(body.model, backend.backendName, upstreamRes.status, responseBody.slice(0, 200));
      }

      return new Response(responseBody, {
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

function createLoggingStream(
  upstreamRes: Response,
  responseHeaders: Headers,
  model: string,
  backendName: string,
  startTime: number,
): Response {
  const reader = upstreamRes.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamedText = '';
  const toolCalls = new Map<number, { name: string; args: string }>();

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        logStreamResponse(model, backendName, Date.now() - startTime, streamedText, toolCalls);
        controller.close();
        return;
      }

      controller.enqueue(value);

      // Parse SSE events for logging
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              streamedText += event.delta.text;
            } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
              const idx = event.index ?? 0;
              const tc = toolCalls.get(idx);
              if (tc) tc.args += event.delta.partial_json;
            }
          } else if (event.type === 'content_block_start') {
            if (event.content_block?.type === 'tool_use') {
              toolCalls.set(event.index ?? 0, {
                name: event.content_block.name ?? '?',
                args: '',
              });
            }
          }
        } catch { /* skip */ }
      }
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(stream, { status: upstreamRes.status, headers: responseHeaders });
}
