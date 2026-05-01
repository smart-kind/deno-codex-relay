import type { ChatRequest, ChatMessage, ChatStreamChunk, DeltaToolCall, ChatLogEntry } from "./types.ts";
import type { UserConfig } from "./config.ts";
import { Config, SessionStore } from "./config.ts";
import { createModuleLogger } from "./logger.ts";
import { UsageStore } from "./usage.ts";
import { appendChatLog, appendSystemError } from "./persist.ts";

const log = createModuleLogger("stream");

export interface StreamArgs {
  url: string;
  apiKey: string;
  fallbackApiKey?: string;
  chatReq: ChatRequest;
  responseId: string;
  sessions: SessionStore;
  priorMessages: ChatMessage[];
  requestMessages: ChatMessage[];
  codexModel: string;
  upstreamModel: string;
  user: UserConfig;
  config: Config;
  usageStore: UsageStore;
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
    fallbackApiKey,
    chatReq,
    responseId,
    sessions,
    priorMessages,
    requestMessages,
    codexModel,
    upstreamModel,
    user,
    config,
    usageStore,
  } = args;

  const msgItemId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  // Emit response.created
  yield sseEvent("response.created", {
    type: "response.created",
    response: { id: responseId, status: "in_progress", model: codexModel },
  });

  log.info("开始流式请求", { responseId, model: codexModel, url, user: user.name });

  // Define interruptive error codes that trigger fallback
  const INTERRUPTIVE_STATUS_CODES = [502, 503, 504, 429];

  let linkType: "primary" | "fallback" = "primary";
  let fallbackReason: string | undefined;
  let usedApiKey = apiKey;

  // Send request to upstream
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (usedApiKey) headers["Authorization"] = `Bearer ${usedApiKey}`;

  let upstream: Response;
  let primaryError: { status: number; error: string } | null = null;

  // Primary attempt
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(chatReq),
    });

    if (!upstream.ok) {
      primaryError = { status: upstream.status, error: await upstream.text().catch(() => "") };

      // Check if we should trigger fallback
      if (INTERRUPTIVE_STATUS_CODES.includes(upstream.status) && fallbackApiKey) {
        log.warn("流式 Primary 失败，切换 Fallback", {
          status: upstream.status,
          user: user.name,
          model: codexModel,
        });

        // Emit fallback triggered event
        yield sseEvent("response.fallback_triggered", {
          type: "response.fallback_triggered",
          response: { id: responseId },
          reason: `primary_${upstream.status}`,
        });

        // Fallback attempt
        const fallbackHeaders: Record<string, string> = { "Content-Type": "application/json" };
        fallbackHeaders["Authorization"] = `Bearer ${fallbackApiKey}`;

        try {
          upstream = await fetch(url, {
            method: "POST",
            headers: fallbackHeaders,
            body: JSON.stringify(chatReq),
          });

          if (upstream.ok) {
            linkType = "fallback";
            fallbackReason = `primary_${primaryError.status}`;
            usedApiKey = fallbackApiKey;
            log.info("流式 Fallback 成功", { user: user.name, model: codexModel });
          } else {
            // Fallback also failed
            const fallbackError = await upstream.text().catch(() => "");
            log.error("流式 Fallback 也失败", { status: upstream.status, user: user.name });

            // Record system error
            await appendSystemError(config.dataDir, {
              timestamp: new Date().toISOString(),
              type: "upstream_error",
              error: `primary_${primaryError.status}, fallback_${upstream.status}`,
              upstream: config.upstream,
              model: upstreamModel,
              request_id: responseId,
              user: user.name,
            });

            yield sseEvent("response.failed", {
              type: "response.failed",
              response: {
                id: responseId,
                status: "failed",
                error: { code: String(upstream.status), message: fallbackError },
              },
            });
            return;
          }
        } catch (fallbackErr) {
          log.error("流式 Fallback 连接失败", { error: String(fallbackErr), user: user.name });

          await appendSystemError(config.dataDir, {
            timestamp: new Date().toISOString(),
            type: "upstream_error",
            error: `primary_${primaryError.status}, fallback_${String(fallbackErr)}`,
            upstream: config.upstream,
            model: upstreamModel,
            request_id: responseId,
            user: user.name,
          });

          yield sseEvent("response.failed", {
            type: "response.failed",
            response: {
              id: responseId,
              status: "failed",
              error: { code: "fallback_connection_error", message: String(fallbackErr) },
            },
          });
          return;
        }
      } else {
        // No fallback or non-interruptive error
        log.error("上游返回错误", { status: primaryError.status, user: user.name });

        // Record system error for 5xx without fallback
        if (primaryError.status >= 500 && !fallbackApiKey) {
          await appendSystemError(config.dataDir, {
            timestamp: new Date().toISOString(),
            type: "upstream_error",
            error: `${primaryError.status}: ${primaryError.error}`,
            upstream: config.upstream,
            model: upstreamModel,
            request_id: responseId,
            user: user.name,
          });
        }

        yield sseEvent("response.failed", {
          type: "response.failed",
          response: {
            id: responseId,
            status: "failed",
            error: { code: String(primaryError.status), message: primaryError.error },
          },
        });
        return;
      }
    }
  } catch (e) {
    log.error("上游连接失败", { error: String(e), user: user.name });
    primaryError = { status: 0, error: String(e) };

    // Network error - try fallback if available
    if (fallbackApiKey) {
      log.warn("流式 Primary 连接异常，切换 Fallback", { user: user.name, model: codexModel });

      yield sseEvent("response.fallback_triggered", {
        type: "response.fallback_triggered",
        response: { id: responseId },
        reason: "primary_connection_error",
      });

      const fallbackHeaders: Record<string, string> = { "Content-Type": "application/json" };
      fallbackHeaders["Authorization"] = `Bearer ${fallbackApiKey}`;

      try {
        upstream = await fetch(url, {
          method: "POST",
          headers: fallbackHeaders,
          body: JSON.stringify(chatReq),
        });

        if (upstream.ok) {
          linkType = "fallback";
          fallbackReason = "primary_connection_error";
          usedApiKey = fallbackApiKey;
          log.info("流式 Fallback 成功", { user: user.name, model: codexModel });
        } else {
          const fallbackError = await upstream.text().catch(() => "");
          log.error("流式 Fallback 也失败", { status: upstream.status, user: user.name });

          await appendSystemError(config.dataDir, {
            timestamp: new Date().toISOString(),
            type: "upstream_error",
            error: `primary_connection_error, fallback_${upstream.status}`,
            upstream: config.upstream,
            model: upstreamModel,
            request_id: responseId,
            user: user.name,
          });

          yield sseEvent("response.failed", {
            type: "response.failed",
            response: {
              id: responseId,
              status: "failed",
              error: { code: String(upstream.status), message: fallbackError },
            },
          });
          return;
        }
      } catch (fallbackErr) {
        log.error("流式 Fallback 连接也异常", { error: String(fallbackErr), user: user.name });

        await appendSystemError(config.dataDir, {
          timestamp: new Date().toISOString(),
          type: "upstream_error",
          error: `primary_connection_error, fallback_${String(fallbackErr)}`,
          upstream: config.upstream,
          model: upstreamModel,
          request_id: responseId,
          user: user.name,
        });

        yield sseEvent("response.failed", {
          type: "response.failed",
          response: {
            id: responseId,
            status: "failed",
            error: { code: "fallback_connection_error", message: String(fallbackErr) },
          },
        });
        return;
      }
    } else {
      await appendSystemError(config.dataDir, {
        timestamp: new Date().toISOString(),
        type: "upstream_error",
        error: String(e),
        upstream: config.upstream,
        model: upstreamModel,
        request_id: responseId,
        user: user.name,
      });

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
  }

  log.debug("上游连接成功", { status: upstream.status, link_type: linkType, user: user.name });

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
  let accumulatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

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

            // Accumulate usage if present (usually in final chunk)
            if (chunk.usage) {
              accumulatedUsage.prompt_tokens = chunk.usage.prompt_tokens;
              accumulatedUsage.completion_tokens = chunk.usage.completion_tokens;
              accumulatedUsage.total_tokens = chunk.usage.total_tokens;
            }

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
    usage: accumulatedUsage,
    link_type: linkType,
    user: user.name,
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

  // Record usage
  await usageStore.recordUsage({
    user: user.name,
    timestamp: new Date().toISOString(),
    input_tokens: accumulatedUsage.prompt_tokens,
    output_tokens: accumulatedUsage.completion_tokens,
    total_tokens: accumulatedUsage.total_tokens,
    model: codexModel,
    upstream_model: upstreamModel,
    link_type: linkType,
    request_id: responseId,
    fallback_reason: fallbackReason,
  });

  // Record chat log
  const chatLogEntry: ChatLogEntry = {
    timestamp: new Date().toISOString(),
    user: user.name,
    request_id: responseId,
    model: codexModel,
    upstream_model: upstreamModel,
    link_type: linkType,
    request: { model: chatReq.model, messages: chatReq.messages, stream: true },
    response: {
      text: accumulatedText,
      reasoning: accumulatedReasoning,
      tool_calls: assistantToolCalls,
      usage: accumulatedUsage,
    },
    usage: { input_tokens: accumulatedUsage.prompt_tokens, output_tokens: accumulatedUsage.completion_tokens },
    fallback_reason: fallbackReason,
  };
  await appendChatLog(config.dataDir, user.name, chatLogEntry);

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
      usage: {
        input_tokens: accumulatedUsage.prompt_tokens,
        output_tokens: accumulatedUsage.completion_tokens,
        total_tokens: accumulatedUsage.total_tokens,
      },
    },
  });
}

/// Format an SSE event string
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}