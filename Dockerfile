# ── Builder stage ──────────────────────────────────────────
FROM rust:1.84-slim AS builder

WORKDIR /build

COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN cargo build --release && cp target/release/codex-relay /codex-relay

# ── Runtime stage ──────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /codex-relay /usr/local/bin/codex-relay

ENV CODEX_RELAY_PORT=4444
ENV CODEX_RELAY_UPSTREAM=https://openrouter.ai/api/v1
ENV CODEX_RELAY_API_KEY=

EXPOSE 4444

ENTRYPOINT ["codex-relay"]
