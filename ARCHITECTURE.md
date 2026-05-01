# codex-relay Architecture

## 1. System Overview

codex-relay is a Deno-based HTTP proxy server that translates OpenAI-style **Responses API** requests into **Chat Completions API** format for upstream providers (e.g., DeepSeek, OpenRouter). It provides:

- Authentication with API key validation
- Usage tracking with configurable limits
- Fallback mechanism for API resilience
- Session management for multi-turn conversations
- Structured logging and error persistence

**Port**: 7150 (configurable via `CODEX_RELAY_PORT`)

---

## 2. Module Responsibilities

| Module | File | Responsibility |
|--------|------|----------------|
| **main** | `main.ts` | HTTP server, route handlers, fallback logic, request orchestration |
| **config** | `config.ts` | Config loading, bidirectional model mapping, user management, SessionStore |
| **types** | `types.ts` | TypeScript interfaces for both API protocols, usage, persistence types |
| **translate** | `translate.ts` | Request/response format conversion (Responses ↔ Chat Completions) |
| **stream** | `stream.ts` | SSE streaming translation, chunk accumulation, fallback for streaming |
| **auth** | `auth.ts` | API key extraction, validation, usage limit enforcement |
| **usage** | `usage.ts` | UsageStore: token counting, in-memory cache, limit checking |
| **persist** | `persist.ts` | File persistence: chat logs (JSONL), usage (JSON), system errors (JSONL) |
| **logger** | `logger.ts` | Module-based structured logging with configurable level and truncation |

---

## 3. API Endpoints

| Endpoint | Method | Handler | Description |
|----------|--------|---------|-------------|
| `/v1/responses` | POST | `handleResponses()` | Main translation endpoint. Supports blocking (`stream: false`) and streaming (`stream: true`). |
| `/v1/models` | GET | `handleModels()` | Proxies upstream `/models`, transforms model IDs using reverse mapping. |
| `/status` | GET | `handleStatus()` | Returns user's usage statistics (tokens, requests, remaining limit). |
| `*` | ANY | inline 404 | Returns 404 for unknown paths. |

### 3.1 POST /v1/responses

**Request Headers**:
- `Authorization: Bearer <api_key>` (required)
- `Content-Type: application/json`

**Request Body** (Responses API format):
```json
{
  "model": "gpt-5.4-mini",
  "input": "Hello, world",
  "instructions": "Be helpful",
  "stream": false,
  "previous_response_id": "resp_123",
  "tools": [{ "type": "function", "name": "get_weather", ... }]
}
```

**Response** (blocking):
```json
{
  "id": "resp_456",
  "model": "gpt-5.4-mini",
  "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "..." }] }],
  "usage": { "input_tokens": 10, "output_tokens": 20, "total_tokens": 30 }
}
```

**Response** (streaming): SSE events:
- `response.created` - stream started
- `output_text.delta` - text chunks
- `function_call_arguments.delta` - tool call chunks
- `response.fallback_triggered` - (if fallback activated)
- `response.output_item.done` - output item completed
- `response.completed` - stream finished

### 3.2 GET /v1/models

Returns list of models with **reverse-mapped** names (upstream → Codex):
```json
{
  "object": "list",
  "data": [
    { "id": "gpt-5.4-mini", "object": "model", "owned_by": "upstream-provider" }
  ]
}
```

### 3.3 GET /status

Returns user usage statistics:
```json
{
  "user": "david",
  "total_tokens": 1000,
  "total_requests": 5,
  "primary_tokens": 800,
  "fallback_tokens": 200,
  "remaining_tokens": 5000,
  "usage_limit": 10000
}
```

---

## 4. Data Flows

### 4.1 Blocking Request Flow

```
Client Request
    │
    ▼
authenticateRequest() ─── [401 if invalid] ───► Error Response
    │
    ▼ [valid]
toChatRequest() ─── Translate to Chat Completions format
    │
    ▼
config.toUpstream() ─── Model name mapping (gpt-5.4-mini → deepseek-v4-flash)
    │
    ▼
fetch(upstream/chat/completions) ─── Primary API key
    │
    ├── [502/503/504/429/connection error]
    │       │
    │       ▼ [if fallback_api_key configured]
    │   fetch(upstream/chat/completions) ─── Fallback API key
    │       │
    │       ├── [success] ───► linkType: "fallback"
    │       │
    │       └ [failure] ───► Error Response
    │
    ▼ [success]
fromChatResponse() ─── Translate to Responses API format
    │
    ▼
sessions.saveWithId() ─── Store conversation history
    │
    ▼
usageStore.recordUsage() ─── Update usage cache + file
    │
    ▼
persist.appendChatLog() ─── Log request/response
    │
    ▼
Response JSON to Client
```

### 4.2 Streaming Request Flow

```
Client Request
    │
    ▼
authenticateRequest()
    │
    ▼
translateStream() generator:
    │
    ├── emit SSE "response.created"
    │
    ▼
fetch(upstream/chat/completions, stream=true)
    │
    ├── [502/503/504/429/connection error]
    │       │
    │       ▼ [if fallback_api_key configured]
    │   emit SSE "response.fallback_triggered"
    │       │
    │       ▼
    │   fetch(upstream, fallback_api_key)
    │
    ▼
accumulate SSE chunks:
    - text deltas → output_text.delta
    - reasoning_content → store for session
    - tool_calls → accumulate by index
    │
    ├── emit SSE "output_text.delta"
    ├── emit SSE "function_call_arguments.delta"
    │
    ▼
emit SSE "response.output_item.done"
emit SSE "response.completed"
    │
    ▼
sessions.saveWithId()
usageStore.recordUsage()
persist.appendChatLog()
    │
    ▼
ReadableStream SSE to Client
```

### 4.3 Multi-turn Conversation Flow

```
Client Request with previous_response_id="resp_123"
    │
    ▼
sessions.getHistory("resp_123")
    │
    ▼ [returns prior messages]
append new input to history
    │
    ▼
send complete message array to upstream
    │
    ▼
sessions.saveWithId("resp_456", full history)
    │
    ▼
return "resp_456" to client (for next turn)
```

---

## 5. Authentication

### 5.1 User Configuration

```typescript
interface UserConfig {
  name: string;       // User identifier
  api_key: string;    // User's API key
  usage_limit?: number; // Optional token limit (undefined = unlimited)
}
```

### 5.2 Authentication Flow

```
Request arrives
    │
    ▼
extractApiKey(req) ─── Parse Authorization header (Bearer or direct)
    │
    ├── [missing] ───► 401 { error: { type: "missing_api_key" } }
    │
    ▼
config.getUserByApiKey(apiKey)
    │
    ├── [not found] ───► 401 { error: { type: "invalid_api_key" } }
    │
    ▼ [found]
usageStore.checkLimit(user)
    │
    ├── [exceeded] ───► 429 { error: { type: "usage_limit_exceeded" } }
    │
    ▼ [valid]
Return AuthResult { user, usageInfo }
```

---

## 6. Usage Tracking

### 6.1 UsageStore

**In-memory cache**: `Map<string, UserUsage>` for fast limit checks

**Methods**:
- `recordUsage(user, record)` — Update cache + write to file
- `getUserUsage(user)` — Read usage (cache-first)
- `checkLimit(user)` — Return `{ exceeded: boolean, remaining: number }`

### 6.2 Usage Record

```typescript
interface UsageRecord {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  link_type: "primary" | "fallback";
  model: string;
  request_id: string;
}
```

### 6.3 Storage Location

```
data/
├── <username>/
│   ├── usage.json       # Cumulative usage stats
│   └── chat-log.jsonl   # Request/response logs
└── system/
    └── errors.jsonl     # System error logs
```

**usage.json format**:
```json
{
  "user": "david",
  "total_tokens": 111,
  "total_requests": 1,
  "primary_tokens": 111,
  "fallback_tokens": 0,
  "last_updated": "2026-05-01T11:55:15.086Z"
}
```

---

## 7. Fallback Mechanism

### 7.1 Trigger Conditions

Fallback activates when primary request fails with:
- HTTP status codes: **502, 503, 504, 429**
- Connection errors (network failure)

### 7.2 Fallback Flow

1. Primary request with `api_key`
2. On trigger condition → check if `fallback_api_key` is configured
3. Retry with `fallback_api_key`
4. Track `linkType: "fallback"` and `fallbackReason`
5. If fallback also fails → record system error and return failure

### 7.3 Streaming Fallback

For streaming requests, emit SSE event:
```
event: response.fallback_triggered
data: {"reason": "502", "message": "Primary upstream returned 502"}
```

---

## 8. Configuration

### 8.1 Configuration Sources (Priority)

1. **JSON file** (`relay-config.json` or `CODEX_RELAY_CONFIG` path)
2. **Environment variables** (fallback)
3. **Defaults** (last resort)

### 8.2 Config Options

| Option | JSON Key | Env Var | Default |
|--------|----------|---------|---------|
| Upstream URL | `upstream` | `CODEX_RELAY_UPSTREAM` | `https://openrouter.ai/api/v1` |
| Primary API Key | `api_key` | `CODEX_RELAY_API_KEY` | "" |
| Fallback API Key | `fallback_api_key` | `CODEX_RELAY_FALLBACK_API_KEY` | "" |
| Model Mapping | `model_mapping` | - | {} |
| Data Directory | `data_dir` | `CODEX_RELAY_DATA_DIR` | "./data" |
| Log Level | `log.level` | `LOG_LEVEL` | "info" |
| Log Truncate | `log.truncate_length` | `LOG_TRUNCATE_LENGTH` | 200 |
| Users | `users[]` | - | [] |
| Port | - | `CODEX_RELAY_PORT` | 7150 |

### 8.3 Model Mapping (Bidirectional)

```json
{
  "model_mapping": {
    "gpt-5.4-mini": "deepseek-v4-flash",
    "gpt-5.5": "deepseek-v4-pro"
  }
}
```

- **Request**: `gpt-5.4-mini` → `deepseek-v4-flash` (toUpstream)
- **Response**: `deepseek-v4-flash` → `gpt-5.4-mini` (toCodex, used in /models)

---

## 9. Module Dependencies

```
main.ts
  ├── config.ts (Config, SessionStore)
  ├── translate.ts (toChatRequest, fromChatResponse)
  ├── stream.ts (translateStream)
  ├── auth.ts (authenticateRequest)
  ├── usage.ts (UsageStore)
  ├── persist.ts (appendChatLog, appendSystemError)
  └── types.ts

stream.ts
  ├── config.ts (SessionStore)
  ├── logger.ts
  ├── usage.ts (UsageStore)
  ├── persist.ts
  └── types.ts

auth.ts
  ├── config.ts (getUserByApiKey)
  ├── usage.ts (checkLimit)
  ├── logger.ts
  └── types.ts

usage.ts
  ├── config.ts (UserConfig)
  ├── persist.ts (readUsageJson, updateUsageJson)
  ├── logger.ts
  └── types.ts

persist.ts
  ├── logger.ts
  └── types.ts

translate.ts
  ├── config.ts (SessionStore)
  ├── logger.ts
  └── types.ts

logger.ts
  └── types.ts (LogConfig)
```

---

## 10. Special Features

### 10.1 Reasoning Content

Handles `reasoning_content` field from thinking-capable models (DeepSeek, Kimi k2.6):
- Stored indexed by `tool_call_id` and turn fingerprint
- Recovered in multi-turn conversations via `getTurnReasoning()`

### 10.2 Tool Call Accumulation

During streaming, tool call deltas are accumulated by index:
- `tool_calls[index].function.arguments` chunks joined
- Complete `function_call` items emitted at stream end

### 10.3 Developer Role Mapping

Responses API `developer` role messages are mapped to `system` role for Chat Completions compatibility.

### 10.4 Session Store

In-memory `Map<string, Session>` keyed by `response_id`:
- Enables multi-turn via `previous_response_id`
- Stores full message history + reasoning content

---

## 11. Error Handling

### 11.1 Authentication Errors

| Error Type | HTTP Status | Description |
|------------|-------------|-------------|
| `missing_api_key` | 401 | No Authorization header |
| `invalid_api_key` | 401 | API key not in user map |
| `usage_limit_exceeded` | 429 | Token limit exceeded |

### 11.2 System Errors

Logged to `data/system/errors.jsonl`:

| Type | Description |
|------|-------------|
| `upstream_error` | Upstream API failure |
| `model_mapping_missing` | Model not in mapping (warning) |
| `unexpected_exception` | Unhandled error |

### 11.3 Response Error Format

```json
{
  "error": {
    "type": "invalid_api_key",
    "message": "API key not found"
  }
}
```