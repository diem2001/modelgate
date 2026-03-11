import type { AnthropicRequest, AnthropicMessage, AnthropicContentBlock, OpenAIRequest, OpenAIMessage, OpenAIContentBlock, OpenAITool } from '../types.js';
import {
  openAIToAnthropic,
  createStreamState,
  createMessageStartEvent,
  createMessageStopEvent,
  openAIChunkToAnthropicEvents,
} from '../transform/openai-to-anthropic.js';
import type { OpenAIResponse, OpenAIStreamChunk } from '../types.js';

/**
 * OpenRouter backend — OpenAI Chat Completions format with cache_control preserved.
 * Unlike openai-compat.ts, this keeps content as structured blocks (not flattened strings)
 * so that cache_control hints from the Anthropic request are forwarded to OpenRouter.
 */
export async function forwardToOpenRouter(
  req: AnthropicRequest,
  baseUrl: string,
  apiKey?: string,
): Promise<Response> {
  const openAIReq = anthropicToOpenRouterFormat(req);
  const url = `${baseUrl}/v1/chat/completions`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify(openAIReq);

  // Debug: check if cache_control is present in outgoing payload
  const hasCacheControl = body.includes('cache_control');
  const systemMsg = openAIReq.messages.find(m => m.role === 'system');
  const systemIsArray = systemMsg && Array.isArray(systemMsg.content);
  console.log(`\x1b[2m  [openrouter] cache_control in payload: ${hasCacheControl}, system content type: ${systemIsArray ? 'blocks' : 'string'}\x1b[0m`);

  const upstreamRes = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!upstreamRes.ok) {
    const errorText = await upstreamRes.text();
    let message: string;
    try {
      const err = JSON.parse(errorText);
      message = err.error?.message ?? errorText;
    } catch {
      message = `Backend error (${upstreamRes.status}): ${errorText}`;
    }

    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message },
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

// ── Anthropic → OpenRouter (OpenAI + cache_control) ──

function convertSystemPrompt(system: AnthropicRequest['system']): OpenAIMessage | null {
  if (!system) return null;

  if (typeof system === 'string') {
    return { role: 'system', content: system };
  }

  // Preserve content blocks with cache_control
  const blocks: OpenAIContentBlock[] = system
    .filter(b => b.type === 'text')
    .map(b => {
      const block: OpenAIContentBlock = { type: 'text', text: b.text ?? '' };
      if (b.cache_control) block.cache_control = b.cache_control as OpenAIContentBlock['cache_control'];
      return block;
    });

  // If no cache_control anywhere, flatten to string
  if (!blocks.some(b => b.cache_control)) {
    return { role: 'system', content: blocks.map(b => b.text).join('') };
  }

  return { role: 'system', content: blocks };
}

function convertMessage(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === 'string') {
    return [{ role: msg.role, content: msg.content }];
  }

  const messages: OpenAIMessage[] = [];
  const textBlocks: OpenAIContentBlock[] = [];
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  const toolResults: OpenAIMessage[] = [];
  let hasCacheControl = false;

  for (const block of msg.content) {
    if (block.type === 'text') {
      const oBlock: OpenAIContentBlock = { type: 'text', text: block.text ?? '' };
      if (block.cache_control) {
        oBlock.cache_control = block.cache_control as OpenAIContentBlock['cache_control'];
        hasCacheControl = true;
      }
      textBlocks.push(oBlock);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id!,
        type: 'function',
        function: {
          name: block.name!,
          arguments: JSON.stringify(block.input),
        },
      });
    } else if (block.type === 'tool_result') {
      const resultContent = typeof block.content === 'string'
        ? block.content
        : block.content
          ? flattenContent(block.content)
          : '';
      toolResults.push({
        role: 'tool',
        content: resultContent,
        tool_call_id: block.tool_use_id,
      });
    }
  }

  if (toolCalls.length > 0 || textBlocks.length > 0) {
    // Use structured content blocks if cache_control is present, otherwise flatten
    const content = hasCacheControl
      ? textBlocks
      : (textBlocks.length > 0 ? textBlocks.map(b => b.text).join('') : null);

    messages.push({
      role: msg.role,
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  messages.push(...toolResults);
  return messages;
}

function flattenContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('');
}

function convertTools(tools: AnthropicRequest['tools']): OpenAITool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function anthropicToOpenRouterFormat(req: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  const systemMsg = convertSystemPrompt(req.system);
  if (systemMsg) messages.push(systemMsg);

  for (const msg of req.messages) {
    messages.push(...convertMessage(msg));
  }

  return {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stop: req.stop_sequences,
    stream: req.stream,
    tools: convertTools(req.tools),
    tool_choice: req.tool_choice,
  };
}

// ── Streaming (reuse openai-to-anthropic transform) ──

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

        // Emit final usage if available
        if (state._inputTokens || state._outputTokens) {
          const usageEvent = `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: {},
            usage: { input_tokens: state._inputTokens, output_tokens: state._outputTokens },
          })}\n\n`;
          controller.enqueue(encoder.encode(usageEvent));
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
