import type {
  AnthropicResponse,
  AnthropicContentBlock,
  OpenAIResponse,
  OpenAIStreamChunk,
} from '../types.js';
import { randomUUID } from 'node:crypto';

export function openAIToAnthropic(res: OpenAIResponse, model: string): AnthropicResponse {
  const choice = res.choices[0];
  if (!choice) {
    return {
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content: AnthropicContentBlock[] = [];

  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const stopReason = mapFinishReason(choice.finish_reason);

  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

function mapFinishReason(reason: string | null): AnthropicResponse['stop_reason'] {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    default: return 'end_turn';
  }
}

// Streaming: convert OpenAI chunks to Anthropic SSE events

interface StreamState {
  messageId: string;
  model: string;
  contentIndex: number;
  textBlockStarted: boolean;
  currentToolCall: { index: number; id: string; name: string; arguments: string } | null;
  _inputTokens: number;
  _outputTokens: number;
}

export function createStreamState(model: string): StreamState {
  return {
    messageId: `msg_${randomUUID().replace(/-/g, '')}`,
    model,
    contentIndex: 0,
    textBlockStarted: false,
    currentToolCall: null,
    _inputTokens: 0,
    _outputTokens: 0,
  };
}

export function openAIChunkToAnthropicEvents(chunk: OpenAIStreamChunk, state: StreamState): string[] {
  const events: string[] = [];

  // Track usage from any chunk (some providers send it separately)
  if (chunk.usage) {
    state._inputTokens = chunk.usage.prompt_tokens ?? state._inputTokens;
    state._outputTokens = chunk.usage.completion_tokens ?? state._outputTokens;
  }

  const choice = chunk.choices?.[0];
  if (!choice) return events;

  const delta = choice.delta;

  // Text content
  if (delta.content) {
    if (!state.textBlockStarted) {
      events.push(sseEvent('content_block_start', {
        type: 'content_block_start',
        index: state.contentIndex,
        content_block: { type: 'text', text: '' },
      }));
      state.textBlockStarted = true;
    }
    events.push(sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: state.contentIndex,
      delta: { type: 'text_delta', text: delta.content },
    }));
  }

  // Tool calls
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.id) {
        // New tool call starting
        if (state.currentToolCall) {
          // Close previous block
          events.push(sseEvent('content_block_stop', {
            type: 'content_block_stop',
            index: state.contentIndex,
          }));
          state.contentIndex++;
        } else if (state.contentIndex === 0 || delta.content === undefined) {
          // Close text block if there was one
          if (state.contentIndex > 0) {
            events.push(sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: state.contentIndex,
            }));
            state.contentIndex++;
          }
        }

        state.currentToolCall = {
          index: tc.index,
          id: tc.id,
          name: tc.function?.name ?? '',
          arguments: tc.function?.arguments ?? '',
        };

        events.push(sseEvent('content_block_start', {
          type: 'content_block_start',
          index: state.contentIndex,
          content_block: {
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name ?? '',
            input: {},
          },
        }));
      } else if (tc.function?.arguments) {
        if (state.currentToolCall) {
          state.currentToolCall.arguments += tc.function.arguments;
        }
        events.push(sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: state.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: tc.function.arguments,
          },
        }));
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    events.push(sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: state.contentIndex,
    }));
    events.push(sseEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapFinishReason(choice.finish_reason),
        stop_sequence: null,
      },
      usage: { output_tokens: state._outputTokens },
    }));
  }

  return events;
}

export function createMessageStartEvent(state: StreamState): string {
  return sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: state._inputTokens, output_tokens: 0 },
    },
  });
}

export function createMessageStopEvent(): string {
  return sseEvent('message_stop', { type: 'message_stop' });
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
