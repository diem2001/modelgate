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
): Promise<Response> {
  const optimized = trimContextForLocalModel(stripToolsFromRequest(req));
  const openAIReq = anthropicToOpenAI(optimized);
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
  // Pretty-print payload with readable message content
  const displayReq = {
    ...openAIReq,
    messages: openAIReq.messages.map(m => ({
      ...m,
      content: typeof m.content === 'string' && m.content.length > 200
        ? m.content.slice(0, 200) + `... (${m.content.length} chars)`
        : m.content,
    })),
  };
  console.log(`\n\x1b[2m┌── OUTGOING PAYLOAD → ${url} ──┐\x1b[0m`);
  console.log(JSON.stringify(displayReq, null, 2));
  console.log(`\x1b[2m└${'─'.repeat(62)}┘\x1b[0m\n`);

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
    if (typeof msg.content !== 'string') return msg;
    let text = msg.content;
    // Strip XML tags (command-name, local-command-stdout, system-reminder, etc.)
    text = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '');
    text = text.replace(/<[^>]+>/g, '');
    // Strip [Request interrupted by user] markers
    text = text.replace(/\[Request interrupted by user\]/g, '');
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { ...msg, content: text };
  }).filter((msg): msg is AnthropicMessage => msg !== null);

  return { ...req, system, messages: cleaned };
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
