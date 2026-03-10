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
    (Cloudflare Tunnel)            (Cloudflare Tunnel)
              │                           │
              │                    Zero Trust Access
              │                    ├─ Service Token (API)
              │                    └─ Email OTP (Browser)
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
              │
    ┌─────────▼──────────┐
    │  api.anthropic.com │
    │  (Claude models)   │
    └────────────────────┘
```

## Request Flow

1. **Client** sends a standard Anthropic `/v1/messages` request to `modelgate.skyvu.de`
2. **Auth middleware** extracts the Bearer token and validates it against `api.anthropic.com/v1/models` (result cached for 60 min). No extra credentials needed — the client's existing Anthropic token is the auth mechanism.
3. **Router** matches the `model` field against glob rules in `modelgate.config.yaml`:
   - `claude-*` → Anthropic API (token passthrough, zero transformation)
   - `qwen*`, `llama*`, `*` → OpenAI-compatible backend (LM Studio)
4. **Format translation** (only for non-Anthropic backends):
   - Request: Anthropic Messages → OpenAI Chat Completions (system prompt, tools, message roles)
   - Response: OpenAI → Anthropic (including SSE streaming event translation)
5. **Cloudflare Access**: Requests to `ai.skyvu.de` carry a CF Service Token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) — the Mac's LM Studio is not exposed without authentication.

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Client → ModelGate | Anthropic token validation (delegated auth, cached) |
| ModelGate → Anthropic | Token passthrough (same client token) |
| ModelGate → LM Studio | Cloudflare Zero Trust Service Token (machine-to-machine) |
| Browser → LM Studio | Cloudflare Zero Trust Email OTP (`dg@diemit.com`) |

No secrets are stored in the proxy itself — Anthropic auth is delegated, CF tokens are injected via environment variables.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Proxy | TypeScript, Hono, Node.js 22 |
| Containerization | Docker (multi-stage build, ~50 MB image) |
| LLM Runtime | LM Studio with MLX backend (Apple Silicon optimized) |
| Networking | Cloudflare Tunnels (no open ports, no port forwarding) |
| Config | YAML (volume-mounted, not baked into image) |

## Key Design Decisions

- **Delegated auth over own user management**: Instead of maintaining a separate user database, ModelGate validates tokens against Anthropic's own API. Anyone with a valid Anthropic key can use the proxy — zero onboarding friction.
- **Cloudflare Tunnels over VPN/port forwarding**: The Mac runs behind NAT with no static IP. CF Tunnels provide stable HTTPS endpoints without network config changes. Zero Trust policies protect the LM Studio endpoint.
- **Format translation at the proxy**: Clients only need to speak Anthropic API. The proxy handles Anthropic ↔ OpenAI format translation including streaming SSE events, tool calls, and system prompts. This means Claude Code works unmodified — just set `ANTHROPIC_BASE_URL`.
- **MLX over llama.cpp**: LM Studio's MLX backend is optimized for Apple Silicon unified memory. Ollama (llama.cpp Metal) has a known bug on M5 chips (#14432).

## Planned Evolution

Current setup is dev/testing on the MacBook (32 GB, ~20-25 t/s). Target production hardware:

**Mac Studio M3 Ultra** (96 GB, 800 GB/s bandwidth, ~4,350 EUR)
- Llama 3.3 70B at Q8_0 quantization (~70 GB, ~1% quality loss)
- ~30-40 tokens/sec — 3x bandwidth improvement over current setup
- Alternatively: dual-model setup (Llama 70B Q6 + Qwen 32B Q6, ~80 GB total)

The proxy architecture stays identical — only `ai.skyvu.de` would point to the Mac Studio instead of the MacBook.
