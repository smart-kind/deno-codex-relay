#!/bin/bash
curl -X POST "https://coding.dashscope.aliyuncs.com/v1/chat/completions" \
  -H "Authorization: Bearer sk-sp-9e805f192896459cb4d4aaeaf1c47b53" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.5-plus",
    "messages": [{"role": "user", "content": "你好"}]
  }'