import { Hono } from 'hono';
import type { AnthropicRequest, AnthropicResponse, AnthropicContentBlock } from '../types.js';
import { resolveBackend } from '../router.js';
import { getConfig } from '../config-store.js';
import { forwardToAnthropic } from '../backends/anthropic.js';
import { forwardToOpenAICompat } from '../backends/openai-compat.js';
import { forwardToLocalAnthropic } from '../backends/local-anthropic.js';
import { forwardToOpenRouter } from '../backends/openrouter.js';
import {
  logRequest, logResponseSync, logStreamStart, logStreamResponse,
  logResponseError, logError,
  type TokenUsage,
} from '../logger.js';
import { insertLog } from '../db.js';

function extractInputText(req: AnthropicRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('\n');
  }
  return '';
}

function extractResponseText(content?: AnthropicContentBlock[]): string {
  if (!content) return '';
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('\n');
}

function extractToolNames(content?: AnthropicContentBlock[]): string[] {
  if (!content) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => b.name ?? '?');
}

export function createMessagesRoute(): Hono {
  const app = new Hono();

  app.post('/v1/messages', async (c) => {
    const config = getConfig();

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

    // Capture original model before any override
    const requestedModel = body.model;

    // Apply model override from routing rule (e.g. haiku → qwen2.5-coder-32b)
    if (backend.modelOverride) {
      body.model = backend.modelOverride;
    }

    // Only store requested_model when it differs from the final model
    const requestedModelLog = requestedModel !== body.model ? requestedModel : null;

    const backendConfig = config.backends[backend.backendName];
    const providerHint = backend.providerPreferences?.order?.[0];
    logRequest(body, backend.backendName, providerHint);

    // Capture request metadata for DB logging
    const requestBody = JSON.stringify(body);
    const inputText = extractInputText(body);
    const turns = body.messages.filter(m => m.role === 'user').length;
    const numTools = body.tools?.length ?? 0;
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
        if (backendConfig?.apiMode === 'openrouter') {
          upstreamRes = await forwardToOpenRouter(body, backend.url, backendConfig.apiKey, backend.providerPreferences);
        } else if (backendConfig?.apiMode === 'anthropic') {
          const optimize = backendConfig?.optimize !== false;
          upstreamRes = await forwardToLocalAnthropic(body, backend.url, backendConfig.apiKey, optimize);
        } else {
          const optimize = backendConfig?.optimize !== false; // default true
          upstreamRes = await forwardToOpenAICompat(
            body, backend.url, backendConfig?.apiKey, optimize,
          );
        }
      }

      const responseHeaders = new Headers();
      const contentType = upstreamRes.headers.get('content-type');
      if (contentType) responseHeaders.set('content-type', contentType);

      // Non-2xx responses — always log as error, even if streaming was requested
      if (upstreamRes.status < 200 || upstreamRes.status >= 300) {
        const errorBody = await upstreamRes.text();
        logResponseError(body.model, backend.backendName, upstreamRes.status, errorBody);

        // Log error to DB
        try {
          insertLog({
            timestamp: new Date().toISOString(),
            model: body.model,
            requested_model: requestedModelLog,
            backend: backend.backendName,
            provider_hint: providerHint ?? null,
            status: upstreamRes.status,
            duration_ms: Date.now() - startTime,
            stream: !!body.stream,
            turns,
            num_tools: numTools,
            input_tokens: 0, output_tokens: 0, cached_tokens: 0,
            cache_write_tokens: 0, reasoning_tokens: 0, cost: null,
            input_text: inputText,
            output_text: errorBody,
            tool_calls: '[]',
            request_body: requestBody,
            response_body: errorBody,
          });
        } catch { /* don't break request on logging failure */ }

        return new Response(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `Backend error (${upstreamRes.status}): ${errorBody}` },
        }), {
          status: upstreamRes.status,
          headers: { 'content-type': 'application/json' },
        });
      }

      // Streaming response
      if (body.stream && upstreamRes.body) {
        logStreamStart(body.model, backend.backendName);
        return createLoggingStream(
          upstreamRes, responseHeaders, body.model, backend.backendName, startTime,
          providerHint ?? null, turns, numTools, inputText, requestBody, requestedModelLog,
        );
      }

      // Sync response
      const responseBody = await upstreamRes.text();
      let content: AnthropicResponse['content'] | undefined;
      let usage: TokenUsage | undefined;
      try {
        const parsed = JSON.parse(responseBody) as AnthropicResponse;
        content = parsed.content;
        if (parsed.usage) {
          const u = parsed.usage as Record<string, number>;
          usage = {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cached: u.cache_read_input_tokens || undefined,
            cacheWrite: u.cache_creation_input_tokens || undefined,
          };
        }
      } catch { /* not JSON */ }

      if (upstreamRes.status >= 200 && upstreamRes.status < 300) {
        logResponseSync(body.model, backend.backendName, upstreamRes.status, Date.now() - startTime, content, usage);
      } else {
        logResponseError(body.model, backend.backendName, upstreamRes.status, responseBody);
      }

      // Log to DB
      try {
        insertLog({
          timestamp: new Date().toISOString(),
          model: body.model,
          requested_model: requestedModelLog,
          backend: backend.backendName,
          provider_hint: providerHint ?? null,
          status: upstreamRes.status,
          duration_ms: Date.now() - startTime,
          stream: false,
          turns,
          num_tools: numTools,
          input_tokens: usage?.input ?? 0,
          output_tokens: usage?.output ?? 0,
          cached_tokens: usage?.cached ?? 0,
          cache_write_tokens: usage?.cacheWrite ?? 0,
          reasoning_tokens: 0,
          cost: usage?.cost ?? null,
          input_text: inputText,
          output_text: extractResponseText(content),
          tool_calls: JSON.stringify(extractToolNames(content)),
          request_body: requestBody,
          response_body: responseBody,
        });
      } catch { /* don't break request on logging failure */ }

      return new Response(responseBody, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    } catch (err) {
      logError(body.model, backend.backendName, err as Error);

      // Log error to DB
      try {
        insertLog({
          timestamp: new Date().toISOString(),
          model: body.model,
          requested_model: requestedModelLog,
          backend: backend.backendName,
          provider_hint: providerHint ?? null,
          status: 502,
          duration_ms: Date.now() - startTime,
          stream: !!body.stream,
          turns,
          num_tools: numTools,
          input_tokens: 0, output_tokens: 0, cached_tokens: 0,
          cache_write_tokens: 0, reasoning_tokens: 0, cost: null,
          input_text: inputText,
          output_text: (err as Error).message,
          tool_calls: '[]',
          request_body: requestBody,
          response_body: '',
        });
      } catch { /* don't break request on logging failure */ }

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
  providerHint: string | null,
  turns: number,
  numTools: number,
  inputText: string,
  requestBody: string,
  requestedModel: string | null,
): Response {
  const reader = upstreamRes.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamedText = '';
  const toolCalls = new Map<number, { name: string; args: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let cost: number | undefined;
  // Collect all SSE data for raw response body
  const rawChunks: string[] = [];

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        const usage: TokenUsage | undefined = (inputTokens || outputTokens) ? {
          input: inputTokens,
          output: outputTokens,
          cached: cachedTokens || undefined,
          cacheWrite: cacheWriteTokens || undefined,
          reasoning: reasoningTokens || undefined,
          cost,
        } : undefined;
        logStreamResponse(model, backendName, Date.now() - startTime, streamedText, toolCalls, usage);

        // Log to DB
        try {
          const toolNames = [...toolCalls.values()].map(t => t.name);
          insertLog({
            timestamp: new Date().toISOString(),
            model,
            requested_model: requestedModel,
            backend: backendName,
            provider_hint: providerHint,
            status: 200,
            duration_ms: Date.now() - startTime,
            stream: true,
            turns,
            num_tools: numTools,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cached_tokens: cachedTokens,
            cache_write_tokens: cacheWriteTokens,
            reasoning_tokens: reasoningTokens,
            cost: cost ?? null,
            input_text: inputText,
            output_text: streamedText,
            tool_calls: JSON.stringify(toolNames),
            request_body: requestBody,
            response_body: rawChunks.join(''),
          });
        } catch { /* don't break stream on logging failure */ }

        controller.close();
        return;
      }

      controller.enqueue(value);

      // Capture raw response
      const chunk = decoder.decode(value, { stream: true });
      rawChunks.push(chunk);

      // Parse SSE events for logging
      buffer += chunk;
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
          } else if (event.type === 'message_start' && event.message?.usage) {
            const u = event.message.usage;
            inputTokens = u.input_tokens ?? 0;
            if (u.cache_read_input_tokens) cachedTokens = u.cache_read_input_tokens;
            if (u.cache_creation_input_tokens) cacheWriteTokens = u.cache_creation_input_tokens;
          } else if (event.type === 'message_delta' && event.usage) {
            const u = event.usage;
            if (u.input_tokens) inputTokens = u.input_tokens;
            if (u.output_tokens) outputTokens = u.output_tokens;
            if (u.cache_read_input_tokens) cachedTokens = u.cache_read_input_tokens;
            if (u.cache_creation_input_tokens) cacheWriteTokens = u.cache_creation_input_tokens;
            if (u.reasoning_tokens) reasoningTokens = u.reasoning_tokens;
            if (u.cost !== undefined) cost = u.cost;
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
