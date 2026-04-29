# Repository Guidelines

## Project Structure & Module Organization

```
codex-relay/
├── src/
│   ├── main.rs          # CLI entry point (Axum server, route setup)
│   ├── lib.rs           # Public API (Python `start()` entry point)
│   ├── session.rs       # Session store for multi-turn conversation state
│   ├── stream.rs        # SSE streaming: Chat Completions → Responses API
│   ├── translate.rs     # Core translation: Responses API ↔ Chat Completions
│   └── types.rs         # Shared request/response types (serde models)
├── codex_relay/
│   └── __init__.py      # Python package (maturin-generated native bindings)
├── tests/
│   └── compat_deepseek_v4_pro.rs  # Reasoning-content round-trip tests
├── Cargo.toml           # Rust project manifest
├── pyproject.toml       # Python build config (maturin)
└── .github/workflows/
    └── publish.yml      # CI: crates.io + PyPI wheel publishing
```

Source code lives in `src/`. Python bindings (for `pip install codex-relay`) are built from the same Rust sources via maturin in `codex_relay/`. Integration-style tests are in `tests/`.

## Build, Test, and Development Commands

| Command | Description |
|---|---|
| `cargo build` | Build the debug binary |
| `cargo run -- --port 4446 --upstream <URL> --api-key <KEY>` | Start the relay server locally |
| `cargo test` | Run all unit and integration tests |
| `cargo clippy` | Run lints for Rust idiomatic style |
| `cargo fmt` | Auto-format all Rust source files |
| `maturin develop` | Build & install the Python wheel for local development |

Use `RUST_LOG=codex_relay=debug cargo run ...` for verbose logging during development.

## Coding Style & Naming Conventions

- **Rust edition 2021** with standard formatting enforced by `rustfmt`. Run `cargo fmt` before committing.
- **Variable and function names:** `snake_case` per Rust convention.
- **Type and enum names:** `PascalCase`.
- **Module organization:** Each core concern gets its own module (`session.rs`, `stream.rs`, `translate.rs`, `types.rs`). Keep modules focused — `translate.rs` handles request conversion, `stream.rs` handles event streaming, etc.
- **Error handling:** Use `anyhow::Result` for fallible functions; prefer `bail!()` for early returns and `context()` for error enrichment.
- **Imports:** Group as `std` → external crates → `crate` with blank lines between groups. Run `cargo fmt` to enforce this.

## Testing Guidelines

- **Framework:** Rust `#[test]` with standard assertions (`assert_eq!`, `assert!`). No external test runner.
- **Test location:** Unit tests go in a `#[cfg(test)] mod tests` block at the bottom of each source file. Integration-style tests that exercise full module interactions go in `tests/`.
- **Naming:** `test_<feature>_<scenario>` — e.g. `test_deepseek_v4_pro_reasoning_roundtrip_text_only`.
- **Coverage focus:** Translation correctness (Responses ↔ Chat Completions), reasoning-content round-trip, tool-call grouping, and streaming event sequencing.
- **Run:** `cargo test` to run the full suite. Use `cargo test <test_name>` to run a single test.

## Commit & Pull Request Guidelines

- **Conventional Commits** are used in this repo. Prefix commit messages with one of: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `style:`, `ci:`, `test:`. Keep the message concise (< 72 chars for the subject line).
- **PR descriptions** should explain the problem being solved, the approach taken, and any configuration or behavior changes. Link related issues where applicable.
- **Scope** PRs to a single concern (e.g. a bug fix, a new provider compatibility, a refactor). Avoid mixing unrelated changes.
- **CI** automatically runs on tags matching `v*` to publish to crates.io and PyPI. Ensure `cargo test` and `cargo clippy` pass before requesting review.

## Configuration & Environment

The relay is configured through environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_RELAY_PORT` | `4444` | TCP port to bind |
| `CODEX_RELAY_UPSTREAM` | `https://openrouter.ai/api/v1` | Upstream Chat Completions base URL |
| `CODEX_RELAY_API_KEY` | *(empty)* | API key sent to upstream |
| `RUST_LOG` | `codex_relay=info` | Log level (use `debug` for verbose) |

Helper scripts (`start-relay.sh`, `test-deepseek-codex.sh`) are provided for quick testing with DeepSeek and Qwen providers.
