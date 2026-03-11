import type { AnthropicRequest, AnthropicMessage, AnthropicContentBlock, AnthropicResponse, OpenAIResponse, OpenAIStreamChunk } from '../types.js';
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
  apiKey?: string,
  cfAccessClientId?: string,
  cfAccessClientSecret?: string,
  optimize = true,
): Promise<Response> {
  const prepared = optimize ? trimContextForLocalModel(stripToolsFromRequest(req)) : req;
  const openAIReq = anthropicToOpenAI(prepared);
  const url = `${baseUrl}/v1/chat/completions`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }
  if (cfAccessClientId && cfAccessClientSecret) {
    headers['CF-Access-Client-Id'] = cfAccessClientId;
    headers['CF-Access-Client-Secret'] = cfAccessClientSecret;
  }

  const body = JSON.stringify(openAIReq);

  const upstreamRes = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!upstreamRes.ok) {
    const errorText = await upstreamRes.text();

    // Extract meaningful error from HTML pages (e.g. Cloudflare error pages)
    let message: string;
    if (errorText.includes('<!DOCTYPE') || errorText.includes('<html')) {
      const titleMatch = errorText.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch?.[1]?.trim() ?? `HTTP ${upstreamRes.status}`;
      message = `Backend error (${upstreamRes.status}): ${title}`;
    } else {
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

        // Emit final usage if available (some providers send it after finish)
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

/**
 * Trim context to fit local model constraints.
 * Claude Code sends the full system prompt (~5k tokens of instructions,
 * billing headers, skill definitions, system reminders) and full conversation
 * history. Local models can't handle this volume efficiently.
 *
 * - Replaces Claude Code's system prompt with a minimal one
 * - Keeps only the last 4 messages (2 user/assistant turns) for context
 */
function trimContextForLocalModel(req: AnthropicRequest): AnthropicRequest {
  // Minimal system prompt — just tell the model to be helpful
  const system = 'You are a helpful coding assistant. Be concise and direct.';

  // Keep only the last N messages for context
  const maxMessages = 4;
  const messages = req.messages.length > maxMessages
    ? req.messages.slice(-maxMessages)
    : req.messages;

  // Ensure conversation starts with a user message (required by most APIs)
  const trimmed = messages[0]?.role === 'assistant'
    ? messages.slice(1)
    : messages;

  // Clean Claude Code noise from message content
  const cleaned = trimmed.map(msg => {
    if (typeof msg.content === 'string') {
      const text = cleanText(msg.content);
      if (!text) return null;
      return { ...msg, content: text };
    }
    if (Array.isArray(msg.content)) {
      // Flatten array of blocks into a single cleaned string
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          const text = cleanText(block.text);
          if (text) parts.push(text);
        }
      }
      if (parts.length === 0) return null;
      return { ...msg, content: parts.join(' ') };
    }
    return msg;
  }).filter((msg): msg is AnthropicMessage => msg !== null);

  // Cap max_tokens for local models (32k wastes VRAM allocation)
  const max_tokens = Math.min(req.max_tokens, 4096);

  return { ...req, system, messages: cleaned, max_tokens };
}

function cleanText(text: string): string {
  // Strip XML tags (command-name, local-command-stdout, system-reminder, etc.)
  text = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '');
  text = text.replace(/<[^>]+>/g, '');
  // Strip ANSI escape codes
  text = text.replace(/\x1b\[[0-9;]*m/g, '');
  // Strip [Request interrupted by user] markers
  text = text.replace(/\[Request interrupted by user\]/g, '');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/**
 * Strip tool definitions and tool-related messages from the request.
 * Local models can't use Claude Code's tools, and the definitions
 * add thousands of tokens to every request.
 *
 * - Removes tools[] and tool_choice
 * - Converts tool_use blocks to text summaries
 * - Converts tool_result blocks to text summaries
 * - Drops empty messages after stripping
 */
function stripToolsFromRequest(req: AnthropicRequest): AnthropicRequest {
  const messages: AnthropicMessage[] = [];

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push(msg);
      continue;
    }

    const newBlocks: AnthropicContentBlock[] = [];

    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        newBlocks.push({
          type: 'text',
          text: `[Tool call: ${block.name}]`,
        });
      } else if (block.type === 'tool_result') {
        const result = typeof block.content === 'string'
          ? block.content
          : '';
        const truncated = result.length > 500 ? result.slice(0, 500) + '...' : result;
        newBlocks.push({
          type: 'text',
          text: truncated ? `[Tool result: ${truncated}]` : '[Tool result]',
        });
      } else {
        newBlocks.push(block);
      }
    }

    if (newBlocks.length > 0) {
      messages.push({ role: msg.role, content: newBlocks });
    }
  }

  return {
    ...req,
    messages,
    tools: undefined,
    tool_choice: undefined,
  };
}
