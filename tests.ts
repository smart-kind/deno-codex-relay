import { assertEquals, assertExists } from "jsr:@std/assert";
import { Config, SessionStore } from "./config.ts";
import { toChatRequest, fromChatResponse } from "./translate.ts";
import type { ResponsesRequest, ChatMessage, ChatResponse } from "./types.ts";

// 测试端口：从环境变量读取，默认 Docker 外部端口 17150
const TEST_PORT = parseInt(Deno.env.get("TEST_PORT") || "17150");
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ── 配置测试 ──────────────────────────────────────────────────────────────

Deno.test("Config.load() 加载配置文件", () => {
  const config = Config.load();
  assertExists(config.upstream);
  // 有 relay-config.json 时会加载 model_mapping
  assertExists(config.modelMapping);
});

Deno.test("Config.toUpstream() 映射模型名", () => {
  const config = new Config("https://api.test.com", "key", {
    "gpt-5.4-mini": "deepseek-v4-flash",
  });
  assertEquals(config.toUpstream("gpt-5.4-mini"), "deepseek-v4-flash");
  assertEquals(config.toUpstream("unknown"), "unknown");
});

Deno.test("Config.toCodex() 反向映射模型名", () => {
  const config = new Config("https://api.test.com", "key", {
    "gpt-5.4-mini": "deepseek-v4-flash",
  });
  assertEquals(config.toCodex("deepseek-v4-flash"), "gpt-5.4-mini");
  assertEquals(config.toCodex("unknown"), "unknown");
});

// ── SessionStore 测试 ─────────────────────────────────────────────────────

Deno.test("SessionStore.save() 和 getHistory()", () => {
  const store = new SessionStore();
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  const id = store.save(messages);

  const history = store.getHistory(id);
  assertEquals(history.length, 1);
  assertEquals(history[0].content, "hello");
});

Deno.test("SessionStore.storeReasoning() 和 getReasoning()", () => {
  const store = new SessionStore();
  store.storeReasoning("call_123", "thinking...");

  assertEquals(store.getReasoning("call_123"), "thinking...");
  assertEquals(store.getReasoning("unknown"), undefined);
});

Deno.test("SessionStore 空 reasoning 不存储", () => {
  const store = new SessionStore();
  store.storeReasoning("call_empty", "");

  assertEquals(store.getReasoning("call_empty"), undefined);
});

// ── 翻译测试 ──────────────────────────────────────────────────────────────

Deno.test("toChatRequest() 文本输入转为 user message", () => {
  const sessions = new SessionStore();
  const req: ResponsesRequest = {
    model: "test-model",
    input: "hello",
  };

  const chatReq = toChatRequest(req, [], sessions);
  assertEquals(chatReq.messages.length, 1);
  assertEquals(chatReq.messages[0].role, "user");
  assertEquals(chatReq.messages[0].content, "hello");
});

Deno.test("toChatRequest() instructions 作为 system message", () => {
  const sessions = new SessionStore();
  const req: ResponsesRequest = {
    model: "test-model",
    input: "hi",
    instructions: "be helpful",
  };

  const chatReq = toChatRequest(req, [], sessions);
  assertEquals(chatReq.messages.length, 2);
  assertEquals(chatReq.messages[0].role, "system");
  assertEquals(chatReq.messages[0].content, "be helpful");
});

Deno.test("toChatRequest() developer role 映射为 system", () => {
  const sessions = new SessionStore();
  const req: ResponsesRequest = {
    model: "test-model",
    input: [{ type: "message", role: "developer", content: "secret" }],
  };

  const chatReq = toChatRequest(req, [], sessions);
  assertEquals(chatReq.messages[0].role, "system");
  assertEquals(chatReq.messages[0].content, "secret");
});

Deno.test("toChatRequest() function_call 分组为单个 assistant message", () => {
  const sessions = new SessionStore();
  const req: ResponsesRequest = {
    model: "test-model",
    input: [
      { type: "function_call", call_id: "c1", name: "fn_a", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "fn_b", arguments: "{}" },
    ],
  };

  const chatReq = toChatRequest(req, [], sessions);
  assertEquals(chatReq.messages.length, 1);
  assertEquals(chatReq.messages[0].role, "assistant");
  assertExists(chatReq.messages[0].tool_calls);
  assertEquals(chatReq.messages[0].tool_calls!.length, 2);
});

Deno.test("toChatRequest() function_call_output 转为 tool message", () => {
  const sessions = new SessionStore();
  const req: ResponsesRequest = {
    model: "test-model",
    input: [{ type: "function_call_output", call_id: "c1", output: "result" }],
  };

  const chatReq = toChatRequest(req, [], sessions);
  assertEquals(chatReq.messages[0].role, "tool");
  assertEquals(chatReq.messages[0].content, "result");
  assertEquals(chatReq.messages[0].tool_call_id, "c1");
});

Deno.test("fromChatResponse() 转换响应格式", () => {
  const chatResp: ChatResponse = {
    choices: [{ message: { role: "assistant", content: "hello world" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  const { response, messages } = fromChatResponse("resp_123", "test-model", chatResp);

  assertEquals(response.id, "resp_123");
  assertEquals(response.object, "response");
  assertEquals(response.model, "test-model");
  assertEquals(response.output[0].type, "message");
  assertEquals(response.output[0].content[0].text, "hello world");
  assertEquals(response.usage.input_tokens, 10);
  assertEquals(messages.length, 1);
});

// ── HTTP 服务器测试 ─────────────────────────────────────

Deno.test({
  name: "GET /v1/models 返回模型列表",
  async fn() {
    const resp = await fetch(`${BASE_URL}/v1/models`);
    const body = await resp.json();
    assertEquals(body.object, "list");
    assertExists(body.data);
  },
});

Deno.test({
  name: "POST /v1/responses 阻塞请求",
  async fn() {
    const resp = await fetch(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "你好",
        stream: false,
      }),
    });

    const body = await resp.json();
    assertEquals(body.object, "response");
    assertExists(body.id);
    assertExists(body.output);
  },
});

Deno.test({
  name: "POST /v1/responses 流式请求",
  async fn() {
    const resp = await fetch(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: "你好",
        stream: true,
      }),
    });

    assertEquals(resp.headers.get("content-type"), "text/event-stream");

    const text = await resp.text();
    assertExists(text.includes("response.created"));
    assertExists(text.includes("response.completed"));
  },
});