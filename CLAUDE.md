# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## What This Is

A lightweight Deno proxy that translates the OpenAI **Responses API** (used by Codex CLI) into the standard **Chat Completions API**, enabling Codex to work with any OpenAI-compatible provider.

**Note**: The original Rust implementation is preserved in `rust/` for reference.

## Quick Commands

```bash
deno task start              # Start relay with relay-config.json
deno task dev                # Start with watch mode
deno task check              # Type check all files
./start-relay.sh             # Start with config file
```

Port: **7150** (configurable via `CODEX_RELAY_PORT` environment variable)

## Architecture

The relay sits between Codex CLI and an upstream provider, translating in real-time:

```
Codex CLI → POST /v1/responses (Responses API) → codex-relay → POST /v1/chat/completions (Chat Completions) → Upstream
```

### Module Structure

| Module | Responsibility |
|--------|---------------|
| `main.ts` | Deno HTTP server, route setup (`/v1/responses`, `/v1/models`, fallback) |
| `config.ts` | JSON config loading, model name mapping (bidirectional), session store |
| `types.ts` | TypeScript types for both API protocols |
| `translate.ts` | Core bidirectional translation: Responses API → Chat Completions and back |
| `stream.ts` | SSE streaming: translates upstream Chat Completions SSE into Responses API SSE events |

### Key Flows

1. **Blocking requests**: `handleResponses` → `toChatRequest` → upstream POST → `fromChatResponse` → JSON response
2. **Streaming requests**: Same translation, but `translateStream` accumulates SSE chunks, emits proper Responses API event sequence (`response.created` → `output_text.delta` → `output_item.done` → `completed`)
3. **Tool calls**: Deltas accumulated by index, emitted as grouped `function_call` items
4. **Session history**: `previous_response_id` → `SessionStore` retrieves prior messages, appends new input, re-sends full conversation to upstream

### Exposed Routes

- `POST /v1/responses` — main translation endpoint (supports `stream: true/false`)
- `GET /v1/models` — proxied from upstream
- All other routes → 404

### Configuration

Configuration via JSON file (recommended) or environment variables.

**JSON config file** (e.g., `relay-config.json`):
```json
{
  "upstream": "https://api.deepseek.com/v1",
  "api_key": "your-api-key",
  "model_mapping": {
    "gpt-5.4-mini": "deepseek-v4-flash",
    "gpt-5.5": "deepseek-v4-pro"
  }
}
```

Model mapping is bidirectional:
- **Requests**: Codex model name → mapped to upstream name before sending
- **Responses**: Upstream model name → mapped back to Codex name in `/v1/models` and SSE events

**Environment variables** (fallbacks if not in config file):

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_RELAY_PORT` | `7150` | TCP port |
| `CODEX_RELAY_UPSTREAM` | `https://openrouter.ai/api/v1` | Upstream base URL |
| `CODEX_RELAY_API_KEY` | _(empty)_ | API key forwarded to upstream |
| `CODEX_RELAY_CONFIG` | _(empty)_ | Path to JSON config file |

**Priority**: Config file values > Environment variables > Defaults

## Testing

```bash
# Blocking request (使用 Codex 期望的模型名，relay 会自动映射)
curl -X POST http://localhost:7150/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4-mini","input":"hello"}'

# Streaming request
curl -X POST http://localhost:7150/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4-mini","input":"hello","stream":true}'
```

## Docker

```bash
docker build -t codex-relay .
docker run -p 7150:7150 -v ./relay-config.json:/app/relay-config.json:ro codex-relay
```