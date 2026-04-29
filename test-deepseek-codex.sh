#!/bin/bash
# Test codex-relay endpoints
# Usage:
#   ./test-deepseek-codex.sh deepseek
#   ./test-deepseek-codex.sh dashscope
#   ./test-deepseek-codex.sh qwen

PROVIDER="${1:-deepseek}"

BASE="http://127.0.0.1:4446"

case "$PROVIDER" in
  deepseek)
    MODEL="deepseek-v4-pro"
    ;;
  dashscope|qwen)
    MODEL="qwen3.5-plus"
    ;;
  *)
    echo "Unknown provider: $PROVIDER"
    echo "Usage: $0 {deepseek|dashscope}"
    exit 1
    ;;
esac

echo "============================================="
echo "  codex-relay endpoint test"
echo "============================================="
echo "  provider: $PROVIDER"
echo "  model:    $MODEL"
echo "============================================="
echo ""

# ── 1. GET /v1/models ──────────────────────────────
echo ">> GET /v1/models"
echo "---"
curl -s "$BASE/v1/models" | python3 -m json.tool 2>/dev/null || curl -s "$BASE/v1/models"
echo ""
echo "---"
echo ""

# ── 2. POST /v1/responses (streaming) ──────────────
echo ">> POST /v1/responses  (model=$MODEL, stream=true)"
echo "---"
curl -s -X POST "$BASE/v1/responses" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"你好，请简短回复\",
    \"stream\": true
  }"
echo ""
echo "---"
echo ""

echo "============================================="
echo "  done"
echo "============================================="
