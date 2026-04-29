# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## What This Is

A lightweight Rust proxy that translates the OpenAI **Responses API** (used by Codex CLI) into the standard **Chat Completions API**, enabling Codex to work with any OpenAI-compatible provider.

## Quick Commands

```bash
cargo build                  # Debug build
cargo run -- --port 4446     # Start relay locally
cargo test                   # All unit + integration tests
cargo test <test_name>       # Single test
cargo clippy                 # Lint
cargo fmt                    # Format
maturin develop              # Build & install Python wheel locally
```

Verbose logging: `RUST_LOG=codex_relay=debug cargo run`

## Architecture

The relay sits between Codex CLI and an upstream provider, translating in real-time:

```
Codex CLI → POST /v1/responses (Responses API) → codex-relay → POST /v1/chat/completions (Chat Completions) → Upstream
```

### Module Structure

| Module | Responsibility |
|--------|---------------|
| `main.rs` | Axum server, route setup (`/v1/responses`, `/v1/models`, fallback) |
| `types.rs` | Serde request/response types for both protocols |
| `translate.rs` | Core bidirectional translation: Responses API → Chat Completions and back |
| `stream.rs` | SSE streaming: translates upstream Chat Completions SSE into Responses API SSE events |
| `session.rs` | Session store for multi-turn conversation state and reasoning_content round-trip |

### Key Flows

1. **Blocking requests**: `handle_responses` → `translate::to_chat_request` → upstream POST → `translate::from_chat_response` → JSON response
2. **Streaming requests**: Same translation, but `stream::translate_stream` accumulates SSE chunks, emits proper Responses API event sequence (`response.created` → `output_text.delta` → `output_item.done` → `completed`)
3. **Tool calls**: Deltas accumulated by index, emitted as grouped `function_call` items
4. **Session history**: `previous_response_id` → `SessionStore` retrieves prior messages, appends new input, re-sends full conversation to upstream

### Exposed Routes

- `POST /v1/responses` — main translation endpoint (supports `stream: true/false`)
- `GET /v1/models` — proxied from upstream
- All other routes → 404

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_RELAY_PORT` | `4444` | TCP port |
| `CODEX_RELAY_UPSTREAM` | `https://openrouter.ai/api/v1` | Upstream base URL |
| `CODEX_RELAY_API_KEY` | _(empty)_ | API key forwarded to upstream |
| `RUST_LOG` | `codex_relay=info` | Log verbosity |

## Testing Scripts

- `./start-relay.sh deepseek` — start with DeepSeek upstream
- `./start-relay.sh dashscope` — start with DashScope/Qwen upstream
- `./test-deepseek-codex.sh deepseek` — test with deepseek-v4-pro model
- `./test-deepseek-codex.sh dashscope` — test with qwen3.5-plus model
