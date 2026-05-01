#!/bin/bash
# Test codex-relay (Deno) endpoints
# Usage:
#   ./test-relay.sh [target] [provider]
#   ./test-relay.sh              # 本地 7150, deepseek
#   ./test-relay.sh docker       # 本地 Docker 17150, deepseek
#   ./test-relay.sh remote       # 远程 ds.crazyamber.com, deepseek
#   ./test-relay.sh local dashscope  # 本地 7150, dashscope

TARGET="${1:-local}"
PROVIDER="${2:-deepseek}"

case "$TARGET" in
  local)
    BASE="http://127.0.0.1:7150"
    ;;
  docker)
    BASE="http://127.0.0.1:17150"
    ;;
  remote|ds)
    BASE="https://ds.crazyamber.com"
    ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Usage: $0 [local|docker|remote] [deepseek|dashscope|qwen]"
    exit 1
    ;;
esac

case "$PROVIDER" in
  deepseek)
    MODEL="gpt-5.4-mini"
    ;;
  dashscope|qwen)
    MODEL="qwen3.5-plus"
    ;;
  *)
    echo "Unknown provider: $PROVIDER"
    echo "Usage: $0 [local|docker|remote] [deepseek|dashscope|qwen]"
    exit 1
    ;;
esac

echo "============================================="
echo "  codex-relay (Deno) endpoint test"
echo "============================================="
echo "  target:   $TARGET"
echo "  base:     $BASE"
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

# ── 2. POST /v1/responses (blocking) ──────────────
echo ">> POST /v1/responses (model=$MODEL, stream=false)"
echo "---"
curl -s -X POST "$BASE/v1/responses" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"input\": \"你好，请简短回复\",
    \"stream\": false
  }" | python3 -m json.tool 2>/dev/null
echo ""
echo "---"
echo ""

# ── 3. POST /v1/responses (streaming) ──────────────
echo ">> POST /v1/responses (model=$MODEL, stream=true)"
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