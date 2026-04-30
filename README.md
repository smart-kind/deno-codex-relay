# codex-relay

A lightweight Deno proxy that translates the OpenAI **Responses API** (used by [Codex CLI](https://github.com/openai/codex)) into the **Chat Completions API**, letting Codex work with any OpenAI-compatible provider — DeepSeek, Kimi, Qwen, Mistral, Groq, xAI, OpenRouter, and more.

## Why

Codex CLI speaks the OpenAI Responses API, which is an OpenAI-proprietary stateful protocol. Every other provider exposes the standard Chat Completions API. `codex-relay` sits between Codex and your chosen provider, translating on the fly — no code changes to Codex required.

## Quick start

**1. Install Deno** (if not already installed)

```bash
# macOS/Linux
curl -fsSL https://deno.land/install.sh | sh
```

**2. Start the relay**

```bash
# With environment variables
CODEX_RELAY_UPSTREAM=https://api.deepseek.com \
CODEX_RELAY_API_KEY=$DEEPSEEK_API_KEY \
deno run --allow-net --allow-read --allow-env main.ts

# Or with config file
./start-relay.sh relay-config.json
```

**3. Configure Codex** (`~/.codex/config.toml`)

```toml
model_provider = "deepseek-relay"

[model_providers.deepseek-relay]
name = "DeepSeek"
base_url = "http://127.0.0.1:17150/v1"

[profiles.ds]
provider = "deepseek-relay"
```

> 注：Docker 映射端口为 `17150:7150`，所以 Codex 连接 `17150`。本地直接运行则用 `7150`。

**4. Use Codex normally** — it routes through the relay transparently.

## Supported providers

| Provider | Base URL |
|---|---|
| DeepSeek | `https://api.deepseek.com` |
| Kimi (Moonshot) | `https://api.moonshot.cn/v1` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| xAI | `https://api.x.ai/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

Any OpenAI-compatible endpoint works.

## Features

- **Streaming** — full SSE streaming with correct event sequencing
- **Tool calls** — accumulates streaming deltas and emits structured function_call items
- **Parallel tool calls** — consecutive function_call input items merged into one assistant message
- **Reasoning models** — preserves `reasoning_content` across turns (Kimi k2.6, DeepSeek-R1)
- **Model catalog** — proxies `/v1/models` from the upstream provider
- **Model mapping** — bidirectional model name translation via config

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CODEX_RELAY_PORT` | `7150` | Port to listen on |
| `CODEX_RELAY_UPSTREAM` | `https://openrouter.ai/api/v1` | Upstream Chat Completions base URL |
| `CODEX_RELAY_API_KEY` | _(empty)_ | API key forwarded to upstream |
| `CODEX_RELAY_CONFIG` | _(empty)_ | Path to JSON config file |

### Config file example (`relay-config.json`)

```json
{
  "upstream": "https://api.deepseek.com",
  "api_key": "your-api-key",
  "model_mapping": {
    "gpt-5.4-mini": "deepseek-v4-flash",
    "gpt-5.5": "deepseek-v4-pro"
  }
}
```

## Docker

```bash
docker build -t codex-relay .
docker run -p 17150:7150 -v ./relay-config.json:/app/relay-config.json:ro codex-relay

# Or with docker-compose
docker compose up
```

## Disclaimer

This project is **not affiliated with, endorsed by, or sponsored by OpenAI**. "Codex" refers to [OpenAI Codex CLI](https://github.com/openai/codex), an open-source project licensed under Apache-2.0. codex-relay is an independent, community-built translation proxy.

## License

MIT