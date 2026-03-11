# ModelGate — Architecture Overview

## Purpose

ModelGate is a lightweight API proxy that provides a **single Anthropic-compatible endpoint** for all LLM traffic. Clients (Claude Code, custom apps) talk Anthropic Messages API — ModelGate decides where the request actually goes based on the model name in the request body.

## System Architecture

```
                         Internet
                            │
              ┌─────────────┴─────────────┐
              │                           │
    modelgate.skyvu.de             ai.skyvu.de
    (nginx + Let's Encrypt)        (nginx + Let's Encrypt)
              │                           │
              │                    SSH Reverse Tunnel
              │                    (autossh -R 11234:localhost:1234)
              │                           │
    ┌─────────▼──────────┐     ┌──────────▼──────────┐
    │  code1.diemit.net  │     │  MacBook Pro M5     │
    │  (VPS / Docker)    │     │  32 GB Unified RAM  │
    │                    │     │                     │
    │  ┌──────────────┐  │     │  ┌───────────────┐  │
    │  │  ModelGate   │  │     │  │  LM Studio    │  │
    │  │  :4000       │  │     │  │  :1234        │  │
    │  │  (Hono/Node) │──┼─────┼──│  MLX backend  │  │
    │  └──────┬───────┘  │     │  │               │  │
    │         │          │     │  │  Qwen 2.5     │  │
    │         │          │     │  │  Coder 32B Q4 │  │
    └─────────┼──────────┘     │  └───────────────┘  │
              │                └─────────────────────┘
    ┌─────────▼──────────┐
    │  api.anthropic.com │
    │  (Claude models)   │
    ├────────────────────┤
    │  openrouter.ai/api │
    │  (Multi-provider)  │
    └────────────────────┘
```

## Request Flow

1. **Client** sends a standard Anthropic `/v1/messages` request to `modelgate.skyvu.de`
2. **Auth middleware** extracts the Bearer token and validates it against `api.anthropic.com/v1/models` (result cached for 60 min). No extra credentials needed — the client's existing Anthropic token is the auth mechanism.
3. **Router** matches the `model` field against glob rules in config:
   - `claude-*` → Anthropic API (token passthrough, zero transformation)
   - `claude-haiku-*` → OpenRouter (OpenAI + cache_control, provider routing)
   - `openrouter/*` → OpenRouter (OpenAI format, full payload)
   - `qwen*`, `llama*`, `*` → Local LLM (LM Studio)
4. **Model override** — routing rules can remap model names (e.g., `claude-haiku-*` → `minimax/minimax-m2.5`)
5. **Backend dispatch** — depending on backend type:
   - **Anthropic**: Direct passthrough (auth headers forwarded as-is)
   - **OpenAI-compat**: Anthropic → OpenAI format translation, optional optimization
   - **OpenRouter**: Anthropic → OpenAI format with `cache_control` preservation + provider routing
   - **Local Anthropic**: Native `/v1/messages` with tool whitelist (Write, Edit, Read, Bash)
6. **Response** is translated back to Anthropic format (if needed) and streamed to client
7. **Cost tracking** — Token usage and cost extracted from response/stream and logged

## Backend Types

### Anthropic (passthrough)
Zero transformation. Client auth token forwarded directly. Used for `api.anthropic.com`.

### OpenAI-compatible
Format translation layer (Anthropic ↔ OpenAI Chat Completions). Supports:
- Message format mapping (system prompts, tool calls, tool results)
- Streaming SSE translation (OpenAI chunks → Anthropic events)
- Token usage extraction from stream chunks

When `optimize: true` (default for local models):
- Strip tool definitions from requests
- Clean XML noise, ANSI codes from context
- Cap `max_tokens` to 4096

When `optimize: false` (cloud backends like OpenRouter):
- Full payload forwarded including all tools and context

### OpenRouter (`apiMode: openrouter`)
Dedicated backend for OpenRouter that preserves prompt caching hints:
- Converts Anthropic content blocks to OpenAI structured blocks with `cache_control` fields
- Strips `x-anthropic-billing-header` from system prompts (changing hash invalidates cache)
- Attaches `provider` object for routing preferences (order, sort, fallbacks, ignore)
- Extracts extended usage from response: cached tokens, cache writes, reasoning tokens, cost
- Reuses `openai-to-anthropic` streaming transform with extended `StreamState`

### Local Anthropic Mode
For backends supporting `/v1/messages` natively (LM Studio with `apiMode: anthropic`):
- Tool whitelist: only Write, Edit, Read, Bash
- Unknown fields stripped (thinking, context_management, output_config)
- Context trimming and noise cleaning
- Direct SSE passthrough (no format conversion)

## Config Architecture

Two-layer config system:

```
modelgate.config.yaml          (base config, checked into git)
    + env overrides            (ANTHROPIC_API_KEY, LMSTUDIO_API_KEY, etc.)
    = baseConfig
        + data/config.yaml     (persistent overlay from admin panel)
        = live config          (in-memory, served by ConfigStore)
```

- **ConfigStore** (`config-store.ts`): Singleton holding live config. Deep-merges base config with persistent overlay per backend so env overrides are preserved.
- **Admin API** (`routes/admin-api.ts`): REST endpoints for CRUD on backends and routing rules. Changes written to `data/config.yaml`.
- **Admin Panel** (`admin/index.html`): SPA at `/admin/` for visual config editing. Protected by Basic Auth.
- **Persistence**: `data/` directory mounted as Docker volume — survives rebuilds.

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Client → ModelGate | Anthropic token validation (delegated auth, cached 60min) |
| ModelGate → Anthropic | Token passthrough (same client token) |
| ModelGate → LM Studio | SSH reverse tunnel (no internet exposure) + API key |
| ModelGate → OpenRouter | API key (env var or admin panel) |
| Admin Panel | HTTP Basic Auth (`ADMIN_USER`/`ADMIN_PASSWORD` env vars) |
| Browser → LM Studio | nginx + Let's Encrypt on ai.skyvu.de |

## Logging

Compact one-line format per request with full cost breakdown:

```
13:45:48  minimax/minimax-m2.5 → openrouter via Minimax  t2 · 32000tok · 60tools · stream
  ▶ What is the capital of France?
  ◀ The capital of France is Paris.
  200 1.2s  30154 in · 25933 cached · 24 out · 19 reason  $0.0020
```

Shows: timestamp, model, backend (+ preferred provider), turn count, max_tokens, tool count, mode, last user input (truncated), response preview, status, duration, token usage (input, cached, cache write, output, reasoning), and dollar cost.

Token usage fields shown when available:
- **in** — input tokens
- **cached** — cache read tokens (green, indicates cost savings)
- **write** — cache write tokens
- **out** — output tokens
- **reason** — reasoning/thinking tokens
- **$X.XXXX** — total cost (from OpenRouter)

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Proxy | TypeScript, Hono, Node.js 22 |
| Admin UI | Vanilla JS, JetBrains Mono, dark theme |
| Containerization | Docker (multi-stage build, ~50 MB image) |
| LLM Runtime | LM Studio with MLX backend (Apple Silicon optimized) |
| Networking | SSH reverse tunnel (Mac → code1), nginx + Let's Encrypt (code1 → internet) |
| Config | YAML (base) + persistent overlay (admin panel) |

## Key Design Decisions

- **Delegated auth over own user management**: Instead of maintaining a separate user database, ModelGate validates tokens against Anthropic's own API. Anyone with a valid Anthropic key can use the proxy — zero onboarding friction.
- **SSH tunnel over Cloudflare Access for LM Studio**: Simpler, faster, no CF dependency. `autossh -R 11234:localhost:1234` from Mac to code1 exposes LM Studio on code1's localhost only.
- **Per-backend optimization flag**: Cloud backends (Anthropic, OpenRouter) get full payloads. Local models get optimized payloads (stripped tools, trimmed context). Configurable per backend via `optimize` field.
- **Two-layer config**: Base YAML for version control + persistent overlay for admin panel changes. Deep merge preserves env var overrides.
- **Format translation at the proxy**: Clients only speak Anthropic API. The proxy handles all format conversion including streaming SSE events. Claude Code works unmodified — just set `ANTHROPIC_BASE_URL`.
- **Prompt caching via cache_control passthrough**: OpenRouter accepts `cache_control` on structured content blocks. The dedicated `openrouter` backend preserves these from Anthropic requests instead of flattening to strings. Stripping `x-anthropic-billing-header` prevents cache invalidation from changing hashes.
- **Provider routing preferences**: OpenRouter-specific `provider` object (order, sort, fallbacks, ignore) configurable via admin panel and persisted in config. Allows pinning requests to specific providers (e.g., Minimax for cost, Anthropic for quality).
