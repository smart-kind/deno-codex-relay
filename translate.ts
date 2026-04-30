import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponsesOutputItem,
  ResponsesUsage,
  ContentPart,
  ChatRequest,
  ChatMessage,
  ChatResponse,
  ChatChoice,
  ChatUsage,
} from "./types.ts";
import { SessionStore } from "./config.ts";
import { createModuleLogger } from "./logger.ts";

const log = createModuleLogger("translate");

/// Convert a Responses API request + prior history into a Chat Completions request.
export function toChatRequest(
  req: ResponsesRequest,
  history: ChatMessage[],
  sessions: SessionStore
): ChatRequest {
  log.debug("开始转换请求", { model: req.model, history_len: history.length });

  const messages: ChatMessage[] = [...history];

  // Prefer `instructions` (Codex CLI) over `system` (other clients).
  const systemText = req.instructions || req.system;
  if (systemText) {
    if (messages.length === 0 || messages[0].role !== "system") {
      messages.unshift({
        role: "system",
        content: systemText,
      });
      log.debug("添加 system message", { content: systemText });
    }
  }

  // Append new input, mapping Responses API roles to Chat Completions roles.
  const input = req.input;
  if (typeof input === "string") {
    // Plain text input
    messages.push({
      role: "user",
      content: input,
    });
    log.debug("文本输入转为 user message", { content: input });
  } else if (Array.isArray(input)) {
    // Process items array
    log.debug("处理 input 数组", { items_count: input.length });

    let i = 0;
    while (i < input.length) {
      const item = input[i] as Record<string, unknown>;
      const itemType = (item?.type as string) || "";

      if (itemType === "function_call") {
        // Collect consecutive function_call items into one assistant message
        const grouped: Record<string, unknown>[] = [];
        let reasoningContent: string | undefined = undefined;

        while (i < input.length) {
          const cur = input[i] as Record<string, unknown>;
          if ((cur?.type as string) !== "function_call") break;

          const callId = (cur?.call_id as string) || "";
          const name = (cur?.name as string) || "";
          const args = (cur?.arguments as string) || "{}";

          if (!reasoningContent) {
            reasoningContent = sessions.getReasoning(callId);
          }

          grouped.push({
            id: callId,
            type: "function",
            function: { name, arguments: args },
          });
          i++;
        }

        const msg: ChatMessage = {
          role: "assistant",
          content: undefined,
          reasoning_content: reasoningContent,
          tool_calls: grouped,
        };

        // Fallback: try turn-level lookup if call_id lookup missed
        if (!msg.reasoning_content) {
          msg.reasoning_content = sessions.getTurnReasoning(messages, msg);
        }

        messages.push(msg);
        log.debug("function_call 分组完成", { tool_calls_count: grouped.length });
      } else {
        switch (itemType) {
          case "function_call_output": {
            const callId = (item?.call_id as string) || "";
            const output = (item?.output as string) || "";
            messages.push({
              role: "tool",
              content: output,
              tool_call_id: callId,
            });
            log.debug("function_call_output 转为 tool message", { call_id: callId });
            break;
          }
          default: {
            // Regular user/assistant/developer message
            let role = (item?.role as string) || "user";
            if (role === "developer") role = "system";

            const content = valueToText(item?.content);
            const msg: ChatMessage = {
              role,
              content: content,
            };

            // For assistant messages, try to recover reasoning_content
            if (msg.role === "assistant") {
              msg.reasoning_content = sessions.getTurnReasoning(messages, msg);
            }

            messages.push(msg);
            log.debug("普通消息添加", { role, content });
          }
        }
        i++;
      }
    }
  }

  const chatReq = {
    model: req.model,
    messages,
    // Keep only `function` tools; providers like DeepSeek don't accept
    // OpenAI-proprietary built-ins (web_search, computer, file_search, …).
    tools: (req.tools || [])
      .filter((t) => (t as Record<string, unknown>)?.type === "function")
      .map(convertTool),
    temperature: req.temperature,
    max_tokens: req.max_output_tokens,
    stream: req.stream || false,
  };

  log.info("请求转换完成", {
    model: chatReq.model,
    messages_count: chatReq.messages.length,
    tools_count: chatReq.tools?.length || 0,
    stream: chatReq.stream,
  });

  return chatReq;
}

/// Responses API tool format → Chat Completions tool format.
/// Responses API (flat): {"type":"function","name":"foo","description":"...","parameters":{...}}
/// Chat Completions (nested): {"type":"function","function":{"name":"foo","description":"...","parameters":{...}}}
function convertTool(tool: unknown): unknown {
  const obj = tool as Record<string, unknown>;
  if (!obj) return tool;

  // Already in Chat Completions format if it has a "function" sub-object.
  if (obj.function) return tool;

  // Convert from Responses API flat format.
  if (obj.type === "function") {
    const func: Record<string, unknown> = {};
    if (obj.name) func.name = obj.name;
    if (obj.description) func.description = obj.description;
    if (obj.parameters) func.parameters = obj.parameters;
    if (obj.strict) func.strict = obj.strict;

    return { type: "function", function: func };
  }

  return tool;
}

/// Convert a Chat Completions response into a Responses API response.
export function fromChatResponse(
  id: string,
  model: string,
  chat: ChatResponse
): { response: ResponsesResponse; messages: ChatMessage[] } {
  log.debug("转换响应", { id, model });

  const choice: ChatChoice = chat.choices?.[0] || {
    message: { role: "assistant", content: "" },
  };

  const text = choice.message?.content || "";
  const usage: ChatUsage = chat.usage || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  const response: ResponsesResponse = {
    id,
    object: "response",
    model,
    output: [{
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text,
      }],
    }],
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
  };

  log.info("响应转换完成", {
    id,
    model,
    output_text_len: text.length,
    tool_calls_count: choice.message?.tool_calls?.length || 0,
    usage: usage,
  });

  return { response, messages: [choice.message] };
}

/// Collapse a Responses API content value (string or parts array) to plain text.
function valueToText(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => (p as Record<string, unknown>)?.text as string)
      .filter(Boolean)
      .join("");
  }
  return String(v);
}