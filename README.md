# codex-relay

A lightweight Deno HTTP proxy that translates the OpenAI **Responses API** (spoken by [Codex CLI](https://github.com/openai/codex)) into the **Chat Completions API**, letting Codex work with any OpenAI-compatible provider — DeepSeek, Kimi, Qwen, Mistral, Groq, xAI, OpenRouter, and more.

## Architecture

```
Codex CLI                    codex-relay                   Upstream Provider
─────────                    ───────────                   ─────────────────
Responses API ───────────► /v1/responses ───translate──► Chat Completions
   (stateful)    Bearer token    │        (stateless)          API
                  auth check     │
                                 ▼
                            SessionStore
                            UsageStore
                            Chat logs
```

The relay sits between Codex and your chosen provider. Codex speaks the Responses API; the relay translates on the fly to standard Chat Completions. No Codex modifications needed.

## Quick start

### 1. Install Deno

```bash
curl -fsSL https://deno.land/install.sh | sh
```

### 2. Create relay config

Copy and edit the example:

```bash
cp relay-config.example.json relay-config.json
```

[`relay-config.example.json`](relay-config.example.json):

```json
{
  "upstream": "https://api.deepseek.com",
  "api_key": "sk-your-upstream-api-key",
  "fallback_api_key": "sk-fallback-key",
  "model_mapping": {
    "gpt-5.4-mini": "deepseek-v4-flash",
    "gpt-5.5": "deepseek-v4-pro",
    "gpt-4.1": "deepseek-v4-flash"
  },
  "log": { "level": "info", "truncate_length": 200 },
  "data_dir": "./data",
  "users": [
    {
      "name": "alice",
      "api_key": "sk-user-alice-key",
      "usage_limit": 10000000
    }
  ]
}
```

| Field | Purpose |
|---|---|
| `upstream` | Chat Completions base URL (relay → provider) |
| `api_key` | API key sent to upstream provider |
| `fallback_api_key` | Retry with this key on 502/503/504/429 errors |
| `model_mapping` | Codex model name → upstream model name (bidirectional) |
| `users` | Client users who can connect to this relay |
| `users[].api_key` | The key Codex must present in its `Authorization` header |
| `users[].usage_limit` | Optional token cap; omit for unlimited |

### 3. Start the relay

```bash
# With config file (recommended)
deno run --allow-net --allow-read --allow-write --allow-env main.ts

# Or via environment variables
CODEX_RELAY_UPSTREAM=https://api.deepseek.com \
CODEX_RELAY_API_KEY=sk-your-key \
deno run --allow-net --allow-read --allow-write --allow-env main.ts
```

Default port is **7150**. Override with `CODEX_RELAY_PORT`.

### 4. Configure Codex

Add to `~/.codex/config.toml`:

```toml
model_provider = "deepseek-relay"

[model_providers.deepseek-relay]
name = "DeepSeek"
base_url = "http://127.0.0.1:7150/v1"
experimental_bearer_token = "sk-user-alice-key"

[profiles.ds]
provider = "deepseek-relay"
model = "deepseek-v4-pro"
```

| Field | Purpose |
|---|---|
| `base_url` | Relay address + `/v1`. Use `127.0.0.1:7150/v1` for local, or your server's IP/domain for remote |
| `experimental_bearer_token` | Must match one of the `users[].api_key` values in `relay-config.json` |
| `[profiles.ds]` | Optional — enables `codex -p ds` to switch to this provider |

> **Auth flow**: Codex sends `Authorization: Bearer <experimental_bearer_token>` → relay validates against its `users` map → relay translates and forwards to upstream with its own `api_key`.

### 5. Use Codex

```bash
codex                    # uses default model_provider
codex -p ds              # uses the "ds" profile
codex -m gpt-5.5         # explicit model
```

## Configuration reference

### Relay (`relay-config.json`)

| Key | Env fallback | Default |
|---|---|---|
| `upstream` | `CODEX_RELAY_UPSTREAM` | `https://openrouter.ai/api/v1` |
| `api_key` | `CODEX_RELAY_API_KEY` | — |
| `fallback_api_key` | `CODEX_RELAY_FALLBACK_API_KEY` | — |
| `model_mapping` | — | `{}` |
| `data_dir` | `CODEX_RELAY_DATA_DIR` | `./data` |
| `log.level` | `LOG_LEVEL` | `"info"` |
| `log.truncate_length` | `LOG_TRUNCATE_LENGTH` | `200` |
| Port | `CODEX_RELAY_PORT` | `7150` |

### Codex (`~/.codex/config.toml`)

```toml
model_provider = "deepseek-relay"

[model_providers.deepseek-relay]
name = "DeepSeek"
base_url = "http://127.0.0.1:7150/v1"
experimental_bearer_token = "sk-user-alice-key"
```

- `base_url` — must end with `/v1`
- `experimental_bearer_token` — the field name includes "experimental" because custom model providers are still an experimental Codex feature. Despite the name, it is the stable way to pass the API key.

## API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/responses` | POST | Main translation. Supports blocking (`stream: false`) and SSE streaming (`stream: true`). Requires `Authorization: Bearer <key>`. |
| `/v1/models` | GET | Proxies upstream model list, reverse-mapping model names back to Codex names. |
| `/status` | GET | Returns current user's usage stats (tokens, requests, remaining limit). |

## Features

- **Streaming** — full SSE streaming with `output_text.delta`, `function_call_arguments.delta`, and correct event lifecycle (`response.created` → `response.completed`)
- **Tool calls** — accumulates streaming tool-call deltas into structured `function_call` items; consecutive calls merged into one assistant message
- **Reasoning models** — preserves `reasoning_content` across multi-turn conversations (DeepSeek-R1, Kimi k2.6)
- **Multi-turn** — session store keyed by `response_id`; pass `previous_response_id` to continue a conversation
- **Authentication** — per-user API keys with optional token usage limits
- **Usage tracking** — per-user token counting with in-memory cache and file persistence (`data/<user>/usage.json`)
- **Fallback** — automatic retry with `fallback_api_key` on 502/503/504/429 or connection errors
- **Chat logging** — request/response logs in JSONL (`data/<user>/chat-log.jsonl`)
- **Error persistence** — system errors logged to `data/system/errors.jsonl`

## Docker

```bash
docker build -t codex-relay .
docker run -p 7150:7150 -v ./relay-config.json:/app/relay-config.json:ro codex-relay

# Or with docker-compose
docker compose up
```

The compose file maps host port `17150` → container port `7150`. Adjust the Codex `base_url` accordingly.

## Supported providers

The relay works with any provider offering an OpenAI-compatible Chat Completions endpoint:

| Provider | Base URL |
|---|---|
| DeepSeek | `https://api.deepseek.com` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| xAI | `https://api.x.ai/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

## License

MIT
