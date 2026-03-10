import type {
  AnthropicRequest,
  AnthropicContentBlock,
  AnthropicMessage,
  OpenAIRequest,
  OpenAIMessage,
  OpenAITool,
} from '../types.js';

function flattenContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

function convertMessage(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === 'string') {
    return [{ role: msg.role, content: msg.content }];
  }

  const messages: OpenAIMessage[] = [];
  const textParts: string[] = [];
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  const toolResults: OpenAIMessage[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push(block.text ?? '');
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

  if (toolCalls.length > 0 || textParts.length > 0) {
    messages.push({
      role: msg.role,
      content: textParts.length > 0 ? textParts.join('') : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  messages.push(...toolResults);
  return messages;
}

function convertTools(tools: AnthropicRequest['tools']): OpenAITool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export function anthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // System prompt
  if (req.system) {
    const systemText = typeof req.system === 'string'
      ? req.system
      : flattenContent(req.system);
    messages.push({ role: 'system', content: systemText });
  }

  // Convert messages
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
