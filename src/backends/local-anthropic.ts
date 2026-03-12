import type { AnthropicRequest, AnthropicMessage, AnthropicContentBlock, AnthropicTool } from '../types.js';

/** Tools allowed for local models — only file/shell operations */
const ALLOWED_TOOLS = new Set(['Write', 'Edit', 'Read', 'Bash']);

export async function forwardToLocalAnthropic(
  req: AnthropicRequest,
  baseUrl: string,
  apiKey?: string,
  optimize = true,
): Promise<Response> {
  const optimized = optimize ? prepareForLocalModel(req) : req;
  const url = `${baseUrl}/v1/messages`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  const body = JSON.stringify(optimized);

  const upstreamRes = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!upstreamRes.ok) {
    const errorText = await upstreamRes.text();

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

  // Pass through directly — LM Studio returns Anthropic format
  return upstreamRes;
}

function prepareForLocalModel(req: AnthropicRequest): AnthropicRequest {
  const system = 'You are a helpful coding assistant. Be concise and direct.';

  // Filter tools to allowed set
  const tools = req.tools?.filter(t => ALLOWED_TOOLS.has(t.name));

  // Keep only the last N messages for context
  const maxMessages = 10;
  const messages = req.messages.length > maxMessages
    ? req.messages.slice(-maxMessages)
    : req.messages;

  // Ensure conversation starts with a user message
  const trimmed = messages[0]?.role === 'assistant'
    ? messages.slice(1)
    : messages;

  // Collect IDs of allowed tool_use blocks so we can match tool_results
  const allowedToolUseIds = new Set<string>();
  for (const msg of trimmed) {
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name && ALLOWED_TOOLS.has(block.name) && block.id) {
        allowedToolUseIds.add(block.id);
      }
    }
  }

  // Clean messages: strip noise but preserve tool_use/tool_result blocks for allowed tools
  const cleaned = trimmed.map(msg => {
    if (typeof msg.content === 'string') {
      const text = cleanText(msg.content);
      if (!text) return null;
      return { ...msg, content: text };
    }
    if (Array.isArray(msg.content)) {
      const newBlocks: AnthropicContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          const text = cleanText(block.text);
          if (text) newBlocks.push({ ...block, text });
        } else if (block.type === 'tool_use' && block.name && ALLOWED_TOOLS.has(block.name)) {
          newBlocks.push(block);
        } else if (block.type === 'tool_result' && block.tool_use_id && allowedToolUseIds.has(block.tool_use_id)) {
          newBlocks.push(block);
        } else if (block.type === 'tool_result') {
          // Convert tool_result for disallowed/removed tools to text
          const resultText = typeof block.content === 'string' ? block.content : '(result)';
          newBlocks.push({ type: 'text', text: `[Tool result: ${cleanText(resultText).slice(0, 200)}]` });
        } else if (block.type === 'tool_use') {
          // Convert disallowed tool_use to text summary
          newBlocks.push({ type: 'text', text: `[Tool call: ${block.name}]` });
        }
      }
      if (newBlocks.length === 0) return null;
      return { ...msg, content: newBlocks };
    }
    return msg;
  }).filter((msg): msg is AnthropicMessage => msg !== null);

  const max_tokens = Math.min(req.max_tokens, 4096);

  const result: AnthropicRequest = {
    model: req.model,
    messages: cleaned,
    system,
    max_tokens,
    stream: req.stream,
  };
  if (tools && tools.length > 0) {
    result.tools = tools;
    result.tool_choice = req.tool_choice;
  }
  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  return result;
}

function cleanText(text: string): string {
  text = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\x1b\[[0-9;]*m/g, '');
  text = text.replace(/\[Request interrupted by user\]/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}
