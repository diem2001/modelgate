import type { AnthropicRequest, AnthropicResponse, OpenAIResponse, OpenAIStreamChunk } from '../types.js';
import { anthropicToOpenAI } from '../transform/anthropic-to-openai.js';
import {
  openAIToAnthropic,
  createStreamState,
  createMessageStartEvent,
  createMessageStopEvent,
  openAIChunkToAnthropicEvents,
} from '../transform/openai-to-anthropic.js';

export async function forwardToOpenAICompat(
  req: AnthropicRequest,
  baseUrl: string,
  cfAccessClientId?: string,
  cfAccessClientSecret?: string,
): Promise<Response> {
  const openAIReq = anthropicToOpenAI(req);
  const url = `${baseUrl}/v1/chat/completions`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfAccessClientId && cfAccessClientSecret) {
    headers['CF-Access-Client-Id'] = cfAccessClientId;
    headers['CF-Access-Client-Secret'] = cfAccessClientSecret;
  }

  const upstreamRes = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(openAIReq),
  });

  if (!upstreamRes.ok) {
    const errorText = await upstreamRes.text();
    return new Response(JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message: `Backend error (${upstreamRes.status}): ${errorText}`,
      },
    }), {
      status: upstreamRes.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (req.stream) {
    return handleStreamingResponse(upstreamRes, req.model);
  }

  const data = await upstreamRes.json() as OpenAIResponse;
  const anthropicRes = openAIToAnthropic(data, req.model);

  return new Response(JSON.stringify(anthropicRes), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function handleStreamingResponse(upstreamRes: Response, model: string): Response {
  const state = createStreamState(model);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      controller.enqueue(encoder.encode(createMessageStartEvent(state)));

      const reader = upstreamRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const chunk = JSON.parse(data) as OpenAIStreamChunk;
              const events = openAIChunkToAnthropicEvents(chunk, state);
              for (const event of events) {
                controller.enqueue(encoder.encode(event));
              }
            } catch {
              // Skip unparseable chunks
            }
          }
        }

        controller.enqueue(encoder.encode(createMessageStopEvent()));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  });
}
