#!/bin/bash
# Start codex-relay with different upstream providers
# Usage:
#   ./start-relay.sh deepseek
#   ./start-relay.sh dashscope

PROVIDER="${1:-deepseek}"

case "$PROVIDER" in
  deepseek)
    export CODEX_RELAY_UPSTREAM=https://api.deepseek.com
    export CODEX_RELAY_API_KEY=sk-8627083c220d4eed8b03d36e4c51ad9d
    ;;
  dashscope|qwen)
    export CODEX_RELAY_UPSTREAM=https://coding.dashscope.aliyuncs.com/v1
    export CODEX_RELAY_API_KEY=sk-sp-9e805f192896459cb4d4aaeaf1c47b53
    ;;
  *)
    echo "Unknown provider: $PROVIDER"
    echo "Usage: $0 {deepseek|dashscope}"
    exit 1
    ;;
esac

export CODEX_RELAY_PORT=4446

echo "============================================="
echo "  Starting codex-relay"
echo "============================================="
echo "  provider: $PROVIDER"
echo "  port:     $CODEX_RELAY_PORT"
echo "  upstream: $CODEX_RELAY_UPSTREAM"
echo "============================================="
echo ""

exec codex-relay
