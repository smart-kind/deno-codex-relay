import type { ChatRequest, ChatMessage, ChatStreamChunk, DeltaToolCall } from "./types.ts";
import { SessionStore } from "./config.ts";
import { createModuleLogger } from "./logger.ts";

const log = createModuleLogger("stream");

export interface StreamArgs {
  url: string;
  apiKey: string;
  chatReq: ChatRequest;
  responseId: string;
  sessions: SessionStore;
  priorMessages: ChatMessage[];
  requestMessages: ChatMessage[];
  codexModel: string;
}

interface ToolCallAccum {
  id: string;
  name: string;
  arguments: string;
}

/// Translate an upstream Chat Completions SSE stream into a Responses API SSE stream.
/// Text response event sequence:
///   response.created → response.output_item.added (message) → response.output_text.delta*
///   → response.output_item.done → response.completed
///
/// Tool call response event sequence:
///   response.created → [accumulate deltas] → response.output_item.added (function_call)
///   → response.function_call_arguments.delta → response.output_item.done → response.completed
export async function* translateStream(
  args: StreamArgs
): AsyncGenerator<string, void, unknown> {
  const {
    url,
    apiKey,
    chatReq,
    responseId,
    sessions,
    priorMessages,
    requestMessages,
    codexModel,
  } = args;

  const msgItemId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  // Emit response.created
  yield sseEvent("response.created", {
    type: "response.created",
    response: { id: responseId, status: "in_progress", model: codexModel },
  });

  log.info("开始流式请求", { responseId, model: codexModel, url });

  // Send request to upstream
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(chatReq),
    });
  } catch (e) {
    log.error("上游连接失败", { error: String(e) });
    yield sseEvent("response.failed", {
      type: "response.failed",
      response: {
        id: responseId,
        status: "failed",
        error: { code: "connection_error", message: String(e) },
      },
    });
    return;
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    log.error("上游返回错误", { status: upstream.status, body });
    yield sseEvent("response.failed", {
      type: "response.failed",
      response: {
        id: responseId,
        status: "failed",
        error: { code: String(upstream.status), message: body },
      },
    });
    return;
  }

  log.debug("上游连接成功", { status: upstream.status });

  const reader = upstream.body?.getReader();
  if (!reader) {
    log.error("无法获取响应 body");
    yield sseEvent("response.failed", {
      type: "response.failed",
      response: {
        id: responseId,
        status: "failed",
        error: { code: "no_body", message: "No response body" },
      },
    });
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedText = "";
  let accumulatedReasoning = "";
  const toolCalls: Map<number, ToolCallAccum> = new Map();
  let emittedMessageItem = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE events in buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          if (!data) continue;

          try {
            const chunk: ChatStreamChunk = JSON.parse(data);
            for (const choice of chunk.choices || []) {
              // Reasoning/thinking content (kimi-k2.6 etc.)
              const rc = choice.delta?.reasoning_content;
              if (rc) accumulatedReasoning += rc;

              // Text content
              const content = choice.delta?.content || "";
              if (content) {
                if (!emittedMessageItem) {
                  yield sseEvent("response.output_item.added", {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                      type: "message",
                      id: msgItemId,
                      role: "assistant",
                      content: [],
                      status: "in_progress",
                    },
                  });
                  emittedMessageItem = true;
                }
                accumulatedText += content;
                yield sseEvent("response.output_text.delta", {
                  type: "response.output_text.delta",
                  item_id: msgItemId,
                  output_index: 0,
                  content_index: 0,
                  delta: content,
                });
              }

              // Tool call deltas — accumulate by index
              const deltaCalls = choice.delta?.tool_calls;
              if (deltaCalls) {
                for (const dc of deltaCalls) {
                  const entry = toolCalls.get(dc.index) || {
                    id: "",
                    name: "",
                    arguments: "",
                  };
                  if (dc.id) entry.id = dc.id;
                  if (dc.function?.name) entry.name += dc.function.name;
                  if (dc.function?.arguments) entry.arguments += dc.function.arguments;
                  toolCalls.set(dc.index, entry);
                }
              }
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Close message item if one was opened
  if (emittedMessageItem) {
    yield sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: msgItemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: accumulatedText }],
      },
    });
  }

  // Emit function_call items for each accumulated tool call
  const baseIndex = emittedMessageItem ? 1 : 0;
  const fcItems: unknown[] = [];

  const toolCallEntries = Array.from(toolCalls.entries());
  for (const [relIdx, [_, tc]] of toolCallEntries.entries()) {
    const fcItemId = `fc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const outputIndex = baseIndex + relIdx;

    yield sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: fcItemId,
        call_id: tc.id,
        name: tc.name,
        arguments: "",
        status: "in_progress",
      },
    });

    if (tc.arguments) {
      yield sseEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: fcItemId,
        output_index: outputIndex,
        delta: tc.arguments,
      });
    }

    yield sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        type: "function_call",
        id: fcItemId,
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        status: "completed",
      },
    });

    fcItems.push({
      type: "function_call",
      id: fcItemId,
      call_id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: "completed",
    });
  }

  log.info("流处理完成", {
    responseId,
    text_len: accumulatedText.length,
    reasoning_len: accumulatedReasoning.length,
    tool_calls_count: toolCalls.size,
  });

  // Persist turn to session store
  for (const tc of toolCalls.values()) {
    if (tc.id) {
      sessions.storeReasoning(tc.id, accumulatedReasoning);
    }
  }

  const assistantToolCalls = toolCalls.size > 0
    ? Array.from(toolCalls.values()).map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }))
    : undefined;

  const assistantMsg: ChatMessage = {
    role: "assistant",
    content: accumulatedText || undefined,
    reasoning_content: accumulatedReasoning || undefined,
    tool_calls: assistantToolCalls,
  };

  // Index reasoning by turn fingerprint
  if (accumulatedReasoning) {
    sessions.storeTurnReasoning(requestMessages, assistantMsg, accumulatedReasoning);
  }

  const messages = [...priorMessages, assistantMsg];
  sessions.saveWithId(responseId, messages);

  log.debug("会话已存储", { responseId, messages_count: messages.length });

  // Build output array for response.completed
  const outputItems: unknown[] = [];
  if (emittedMessageItem) {
    outputItems.push({
      type: "message",
      id: msgItemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: accumulatedText }],
    });
  }
  outputItems.push(...fcItems);

  yield sseEvent("response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      model: codexModel,
      output: outputItems,
    },
  });
}

/// Format an SSE event string
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}