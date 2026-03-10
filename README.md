# ModelGate

An Anthropic-compatible LLM proxy that routes requests to multiple backends.

## Concept

ModelGate sits between an Anthropic SDK client (like Claude Code) and multiple LLM backends. It accepts requests in **Anthropic Messages API format** (`/v1/messages`) and routes them to:

- **Anthropic API** — direct passthrough for Claude models
- **Ollama** — local models (e.g., `qwen2.5-coder:32b`) via OpenAI-compatible API with automatic format translation

```
┌─────────────┐         ┌──────────────┐         ┌──────────────────┐
│ Claude Code  │ ──────► │  ModelGate   │ ──────► │  Anthropic API   │
│ (Anthropic   │         │  Proxy       │         │  (Claude models) │
│  SDK)        │         │              │         └──────────────────┘
└─────────────┘         │  /v1/messages │
                        │              │         ┌──────────────────┐
                        │  Route by    │ ──────► │  Ollama          │
                        │  model name  │         │  (qwen2.5-coder, │
                        └──────────────┘         │   llama, etc.)   │
                                                 └──────────────────┘
```

## Why not LiteLLM?

LiteLLM has a beta `/v1/messages` endpoint, but:
- Heavy Python dependency (~200+ packages)
- Overkill for a focused routing use case
- Less control over format translation and error handling

ModelGate is lightweight, TypeScript-native, and purpose-built.

## Features (Planned)

- **Anthropic Messages API** — Full `/v1/messages` endpoint (streaming + non-streaming)
- **Model-based routing** — `claude-*` → Anthropic, everything else → Ollama
- **Format translation** — Automatic Anthropic ↔ OpenAI format mapping
  - Messages (system, user, assistant roles)
  - Tool/function calling
  - Streaming (SSE)
- **Configurable routing rules** — YAML/JSON config for model → backend mapping
- **Request/response logging** — Optional logging for debugging and cost tracking
- **Zero dependencies on Python** — Pure TypeScript/Node.js

## Tech Stack

- **Runtime:** Node.js 22+
- **Language:** TypeScript
- **HTTP Framework:** Hono (lightweight, fast)
- **Config:** YAML

## Configuration (Draft)

```yaml
# modelgate.config.yaml
server:
  port: 4000
  host: 0.0.0.0

backends:
  anthropic:
    url: https://api.anthropic.com
    apiKey: ${ANTHROPIC_API_KEY}

  ollama:
    url: http://localhost:11434

routing:
  rules:
    - match: "claude-*"
      backend: anthropic
    - match: "qwen*"
      backend: ollama
    - match: "llama*"
      backend: ollama
    - match: "*"  # fallback
      backend: ollama
```

## Usage (Draft)

```bash
# Start the proxy
modelgate start

# Or with config
modelgate start --config modelgate.config.yaml

# Point Claude Code at the proxy
export ANTHROPIC_BASE_URL=http://localhost:4000
```

## Format Translation

The core challenge is translating between Anthropic and OpenAI message formats:

| Feature | Anthropic Format | OpenAI Format |
|---------|-----------------|---------------|
| System prompt | Top-level `system` field | `{"role": "system"}` message |
| Tool definitions | `tools[].input_schema` | `tools[].function.parameters` |
| Tool calls | `content[].type: "tool_use"` | `tool_calls[].function` |
| Tool results | `content[].type: "tool_result"` | `{"role": "tool"}` message |
| Streaming | SSE with `message_start`, `content_block_delta` | SSE with `chat.completion.chunk` |
| Stop reason | `stop_reason: "end_turn"` | `finish_reason: "stop"` |

## License

MIT
