# ModelGate

Anthropic-compatible LLM proxy that routes requests to multiple backends based on model name.

## How It Works

ModelGate accepts requests in **Anthropic Messages API format** (`/v1/messages`) and routes them by model name:

- `claude-*` → **Anthropic API** (direct passthrough)
- Everything else → **OpenAI-compatible backends** (LM Studio, Ollama, etc.) with automatic format translation

```
Claude Code / Anthropic SDK
  │  Authorization: Bearer <anthropic-token>
  ▼
ModelGate (/v1/messages)
  │  Validates token against Anthropic API (60min cache)
  ├─ claude-*  → api.anthropic.com (token passthrough)
  └─ qwen*/llama*/* → OpenAI-compatible backend (LM Studio, Ollama, etc.)
```

## Features

- **Anthropic Messages API** — Full `/v1/messages` endpoint (streaming + non-streaming)
- **Model-based routing** — Glob-pattern rules in YAML config
- **Format translation** — Automatic Anthropic ↔ OpenAI format mapping (messages, tool calls, streaming)
- **Auth** — Validates incoming tokens against Anthropic API with configurable cache TTL
- **Cloudflare Access** — Optional CF Service Token headers for protected backends
- **Request logging** — Configurable verbosity (minimal / standard / verbose)

## Quick Start

```bash
# Install
npm install

# Development
npm run dev

# Build + run
npm run build && npm start

# Docker
docker compose up -d --build
```

## Configuration

Copy and edit the config file:

```bash
cp modelgate.config.yaml modelgate.config.example.yaml
```

```yaml
server:
  port: 4000
  host: 0.0.0.0

auth:
  enabled: true
  cacheTtlMinutes: 60

logging:
  level: standard  # minimal | standard | verbose

backends:
  anthropic:
    url: https://api.anthropic.com

  lmstudio:
    url: http://localhost:1234
    # Optional: Cloudflare Access headers (set via env vars)

routing:
  rules:
    - match: "claude-*"
      backend: anthropic
    - match: "*"
      backend: lmstudio
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for Anthropic backend (optional, client can pass its own) |
| `PORT` | Override server port |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access Service Token client ID (for protected backends) |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access Service Token secret (for protected backends) |

## Usage with Claude Code

```bash
export ANTHROPIC_BASE_URL=https://modelgate.skyvu.de  # or http://localhost:4000
# Auth works automatically — Claude Code's OAuth token validates against Anthropic
```

## Format Translation

| Feature | Anthropic Format | OpenAI Format |
|---------|-----------------|---------------|
| System prompt | Top-level `system` field | `{"role": "system"}` message |
| Tool definitions | `tools[].input_schema` | `tools[].function.parameters` |
| Tool calls | `content[].type: "tool_use"` | `tool_calls[].function` |
| Tool results | `content[].type: "tool_result"` | `{"role": "tool"}` message |
| Streaming | SSE with `message_start`, `content_block_delta` | SSE with `chat.completion.chunk` |
| Stop reason | `stop_reason: "end_turn"` | `finish_reason: "stop"` |

## Project Structure

```
src/
├── index.ts                          # Hono server + auth middleware
├── auth.ts                           # Token validation (Anthropic API, cached)
├── config.ts                         # YAML config loader + env overrides
├── router.ts                         # Model → backend routing (glob matching)
├── logger.ts                         # Request/response logging
├── types.ts                          # Anthropic + OpenAI type definitions
├── backends/
│   ├── anthropic.ts                  # Anthropic API passthrough
│   └── openai-compat.ts             # OpenAI-compatible backend (LM Studio, etc.)
├── transform/
│   ├── anthropic-to-openai.ts        # Request format: Anthropic → OpenAI
│   └── openai-to-anthropic.ts        # Response format: OpenAI → Anthropic
└── routes/
    └── messages.ts                   # POST /v1/messages handler
```

## Tech Stack

- **Runtime:** Node.js 22
- **Language:** TypeScript
- **HTTP:** Hono
- **Config:** YAML

## License

MIT
