#!/bin/bash
# 真正的 fallback 集成测试：relay + mock upstream

set -e

echo "=== Fallback 集成测试 ==="

# 1. 启动 mock upstream (返回 502)
echo "1. 启动 mock upstream (返回 502)"
MOCK_PORT=19991

# 用 deno 启动一个简单的 mock server
deno run --allow-net tests/mock-upstream-502.ts &
MOCK_PID=$!
sleep 2

# 2. 创建临时 relay 配置指向 mock
echo "2. 创建 relay 配置指向 mock upstream"
cat > test-relay-integration-config.json << EOF
{
  "upstream": "http://localhost:${MOCK_PORT}",
  "api_key": "test-primary-key",
  "fallback_api_key": "test-fallback-key",
  "model_mapping": { "test-model": "mock-model" },
  "data_dir": "./data",
  "users": [{ "name": "test-user", "api_key": "sk-test-integration-key" }]
}
EOF

# 3. 启动 relay server
echo "3. 启动 relay server"
CODEX_RELAY_CONFIG=test-relay-integration-config.json deno run --allow-net --allow-read --allow-write --allow-env main.ts &
RELAY_PID=$!
sleep 2

# 4. 对 relay 发请求
echo "4. 对 relay 发请求 (应该触发 fallback)"
curl -s -X POST http://localhost:7150/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-test-integration-key" \
  -d '{"model":"test-model","input":"hello","stream":false}' || echo "请求失败（预期）"

sleep 1

# 5. 检查 system errors
echo "5. 检查 system errors 记录"
if [ -f "./data/system/errors.jsonl" ]; then
  echo "✓ system/errors.jsonl 存在"
  cat ./data/system/errors.jsonl
else
  echo "✗ system/errors.jsonl 不存在 - 测试失败"
fi

# 清理
echo "6. 清理"
kill $RELAY_PID 2>/dev/null
kill $MOCK_PID 2>/dev/null
rm test-relay-integration-config.json

echo "=== 测试完成 ==="