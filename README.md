# ModelGate

Anthropic-compatible LLM proxy that routes requests to multiple backends based on model name.

## How It Works

ModelGate accepts requests in **Anthropic Messages API format** (`/v1/messages`) and routes them by model name:

- `claude-*` → **Anthropic API** (direct passthrough)
- `claude-haiku-*` → **OpenRouter** (cost-optimized with prompt caching)
- `openrouter/*` → **OpenRouter** (OpenAI-compatible, full payload)
- Everything else → **Local LLM** (LM Studio via OpenAI or Anthropic API mode)

```
Claude Code / Anthropic SDK
  │  Authorization: Bearer <anthropic-token>
  ▼
ModelGate (/v1/messages)
  │  Validates token against Anthropic API (60min cache)
  ├─ claude-*       → api.anthropic.com (token passthrough)
  ├─ claude-haiku-* → openrouter.ai/api (OpenAI + cache_control, provider routing)
  ├─ openrouter/*   → openrouter.ai/api (OpenAI format, no optimization)
  └─ qwen*/llama*   → LM Studio (OpenAI or Anthropic mode, optimized)
```

## Features

- **Anthropic Messages API** — Full `/v1/messages` endpoint (streaming + non-streaming)
- **Multi-backend routing** — Glob-pattern rules with model override support
- **Format translation** — Automatic Anthropic ↔ OpenAI format mapping (messages, tools, streaming SSE)
- **Anthropic API mode** — Local backends can use `/v1/messages` natively (LM Studio) with tool whitelist
- **Per-backend optimization** — Tool stripping, context trimming, max_tokens capping for local models
- **OpenRouter prompt caching** — Preserves `cache_control` fields for prompt caching (up to 89% cost savings)
- **Provider routing** — Configurable provider order, sort (price/throughput/latency), fallbacks, and ignore list for OpenRouter
- **Cost tracking** — Full cost breakdown in logs: cached tokens, cache writes, reasoning tokens, dollar cost
- **Admin panel** — Web UI for live config editing (backends, routing rules, API keys, provider preferences) at `/admin/`
- **Persistent config** — Changes via admin panel persist across Docker rebuilds (`data/config.yaml`)
- **Auth** — Validates incoming tokens against Anthropic API with configurable cache TTL
- **Admin Basic Auth** — `/admin/*` protected via `ADMIN_USER`/`ADMIN_PASSWORD` env vars
- **Compact logging** — One-line per request/response with full token usage and cost breakdown

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

### Config File (`modelgate.config.yaml`)

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
    apiMode: anthropic    # openai (default) or anthropic (/v1/messages)
    optimize: true        # strip tools, trim context, cap max_tokens

  openrouter:
    url: https://openrouter.ai/api
    apiMode: openrouter   # preserves cache_control for prompt caching
    optimize: false       # send full payload (cloud model)
    providerPreferences:  # OpenRouter-specific provider routing
      order: ["Minimax"]
      allow_fallbacks: false
      sort: price         # price | throughput | latency

routing:
  rules:
    - match: "claude-haiku-*"
      backend: lmstudio
      model: qwen2.5-coder-32b    # model override
    - match: "claude-*"
      backend: anthropic
    - match: "openrouter/*"
      backend: openrouter
    - match: "*"
      backend: lmstudio
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for Anthropic backend (optional, client can pass its own) |
| `LMSTUDIO_API_KEY` | API key for LM Studio backend |
| `LMSTUDIO_API_MODE` | `openai` (default) or `anthropic` for LM Studio |
| `OPENROUTER_API_KEY` | API key for OpenRouter backend |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access client ID (for backend auth) |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access client secret |
| `ADMIN_USER` | Admin panel username (default: `admin`) |
| `ADMIN_PASSWORD` | Admin panel password (required to enable Basic Auth) |
| `PORT` | Override server port |

### Admin Panel

Live config editor at `/admin/` — edit backends, routing rules, and API keys without restarting. Protected by Basic Auth when `ADMIN_PASSWORD` is set.

Changes are persisted to `data/config.yaml` and survive Docker rebuilds (mounted as volume).

## Backend Modes

### Anthropic (passthrough)
Direct proxy to `api.anthropic.com`. Client auth token is forwarded as-is. No format translation.

### OpenAI-compatible (default for local models)
Translates Anthropic → OpenAI Chat Completions format. When `optimize: true`:
- Strips tool definitions from requests
- Trims conversation context (cleans XML noise, ANSI codes)
- Caps `max_tokens` to 4096

### OpenRouter (`apiMode: openrouter`)
OpenAI Chat Completions format with **prompt caching** support:
- Preserves `cache_control` fields on content blocks (Anthropic → OpenAI structured blocks)
- Strips `x-anthropic-billing-header` from system prompts (prevents cache invalidation)
- Provider routing preferences: order, sort, fallbacks, ignore list
- Full cost breakdown from OpenRouter usage data (cached tokens, cache writes, reasoning, cost)

### Anthropic API mode (local)
For backends supporting `/v1/messages` natively (LM Studio). Set `apiMode: anthropic`. Features:
- Tool whitelist: only Write, Edit, Read, Bash tools are forwarded
- Unknown fields stripped (thinking, context_management, etc.)
- Context trimming and noise cleaning

## Usage with Claude Code

```bash
export ANTHROPIC_BASE_URL=https://modelgate.skyvu.de  # or http://localhost:4000
# Auth works automatically — Claude Code's OAuth token validates against Anthropic
```

## Logging

Compact one-line format with full cost breakdown:

```
13:45:48  minimax/minimax-m2.5 → openrouter via Minimax  t2 · 32000tok · 60tools · stream
  ▶ What is the capital of France?
  ◀ The capital of France is Paris.
  200 1.2s  30154 in · 25933 cached · 24 out · 19 reason  $0.0020
```

Shows: timestamp, model, backend (+ provider if configured), turn count, max tokens, tool count, mode, last user input, response preview, status, duration, token usage (input, cached, cache write, output, reasoning), and cost.

## Project Structure

```
src/
├── index.ts                          # Hono server, auth + admin middleware
├── auth.ts                           # Token validation (Anthropic API, cached)
├── config.ts                         # YAML config loader + env overrides
├── config-store.ts                   # Live config store with persistence
├── router.ts                         # Model → backend routing (glob matching)
├── logger.ts                         # Compact request/response logging
├── types.ts                          # Anthropic + OpenAI type definitions
├── backends/
│   ├── anthropic.ts                  # Anthropic API passthrough
│   ├── openai-compat.ts             # OpenAI-compatible backend (LM Studio)
│   ├── openrouter.ts                # OpenRouter backend (OpenAI + cache_control + provider routing)
│   └── local-anthropic.ts           # Anthropic API mode for local models
├── transform/
│   ├── anthropic-to-openai.ts        # Request format: Anthropic → OpenAI
│   └── openai-to-anthropic.ts        # Response format: OpenAI → Anthropic (+ streaming)
└── routes/
    ├── messages.ts                   # POST /v1/messages handler
    └── admin-api.ts                  # Admin REST API (backends, routing CRUD)
admin/
└── index.html                        # Admin panel SPA (dark theme, vanilla JS)
data/
└── config.yaml                       # Persistent config (Docker volume)
```

## Tech Stack

- **Runtime:** Node.js 22
- **Language:** TypeScript
- **HTTP:** Hono
- **Config:** YAML (base) + persistent overlay
- **Container:** Docker (multi-stage alpine build)

## License

MIT
