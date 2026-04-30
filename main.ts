import { Config, SessionStore } from "./config.ts";
import { toChatRequest, fromChatResponse } from "./translate.ts";
import { translateStream } from "./stream.ts";
import { createModuleLogger } from "./logger.ts";
import type { ResponsesRequest, ChatRequest, ChatResponse } from "./types.ts";

const log = createModuleLogger("main");

// Default port
const PORT = parseInt(Deno.env.get("CODEX_RELAY_PORT") || "7150");

// Global state
const config = Config.load();
const sessions = new SessionStore();

log.info("服务器启动", { port: PORT, upstream: config.upstream, log_level: config.logLevel });

Deno.serve({ port: PORT }, async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname;

  // POST /v1/responses — main translation endpoint
  if (req.method === "POST" && path === "/v1/responses") {
    return handleResponses(req);
  }

  // GET /v1/models — proxy to upstream with model name mapping
  if (req.method === "GET" && path === "/v1/models") {
    return handleModels();
  }

  // Fallback: 404
  log.warn("未知路径", { method: req.method, path });
  return new Response("not found", { status: 404 });
});

/// GET /v1/models — proxy to upstream and transform model names if mapping configured.
async function handleModels(): Promise<Response> {
  log.debug("请求模型列表");

  const url = `${stripTrailingSlash(config.upstream)}/models`;
  const headers: Record<string, string> = {};
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      log.error("上游模型列表请求失败", { status: resp.status });
      return Response.json({ object: "list", data: [] });
    }

    const body = await resp.json();
    const transformed = transformModelsResponse(body);
    log.info("模型列表返回", { models_count: (transformed as Record<string, unknown>)?.data?.length || 0 });
    return Response.json(transformed);
  } catch (e) {
    log.error("模型列表请求异常", { error: String(e) });
    return Response.json({ object: "list", data: [] });
  }
}

/// Transform model IDs in /v1/models response from upstream names to Codex names.
function transformModelsResponse(body: unknown): unknown {
  if (!config.modelMapping || Object.keys(config.modelMapping).length === 0) {
    return body;
  }

  const result = body as Record<string, unknown>;
  const data = result?.data as unknown[];
  if (!Array.isArray(data)) return body;

  let mappedCount = 0;
  for (const modelObj of data) {
    const obj = modelObj as Record<string, unknown>;
    const id = obj?.id as string;
    if (id) {
      const mappedId = config.toCodex(id);
      if (mappedId !== id) {
        obj.id = mappedId;
        mappedCount++;
      }
    }
  }

  if (mappedCount > 0) {
    log.debug("模型名称映射", { mapped_count: mappedCount });
  }

  return result;
}

/// POST /v1/responses — handle both blocking and streaming requests.
async function handleResponses(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (e) {
    log.error("JSON 解析失败", { error: String(e) });
    return new Response(String(e), { status: 422 });
  }

  const responsesReq = body as ResponsesRequest;
  log.info("收到请求", {
    model: responsesReq.model,
    stream: responsesReq.stream,
    input_type: typeof responsesReq.input,
    previous_response_id: responsesReq.previous_response_id,
    tools_count: responsesReq.tools?.length || 0,
  });

  // Get history from previous_response_id
  const history = responsesReq.previous_response_id
    ? sessions.getHistory(responsesReq.previous_response_id)
    : [];

  if (history.length > 0) {
    log.debug("恢复历史会话", { history_count: history.length, previous_id: responsesReq.previous_response_id });
  }

  // Apply model name mapping: Codex name → upstream name
  const codexModel = responsesReq.model;
  const upstreamModel = config.toUpstream(codexModel);
  if (upstreamModel !== codexModel) {
    log.info("模型映射", { codex_model: codexModel, upstream_model: upstreamModel });
  }

  // Build Chat Completions request
  const chatReq = toChatRequest(responsesReq, history, sessions);
  chatReq.model = upstreamModel;
  const url = `${stripTrailingSlash(config.upstream)}/chat/completions`;

  if (responsesReq.stream) {
    // Streaming response
    const responseId = sessions.newId();
    chatReq.stream = true;
    const requestMessages = [...chatReq.messages];

    log.debug("流式请求开始", { responseId, url });

    const stream = translateStream({
      url,
      apiKey: config.apiKey,
      chatReq,
      responseId,
      sessions,
      priorMessages: history,
      requestMessages,
      codexModel,
    });

    const body = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } else {
    // Blocking response
    chatReq.stream = false;
    return handleBlocking(chatReq, url, codexModel);
  }
}

/// Handle blocking (non-streaming) request.
async function handleBlocking(
  chatReq: ChatRequest,
  url: string,
  codexModel: string
): Promise<Response> {
  log.debug("阻塞请求开始", { url, model: chatReq.model });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(chatReq),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log.error("上游返回错误", { status: resp.status, body });
      return new Response(body, { status: resp.status });
    }

    const chatResp: ChatResponse = await resp.json();

    // Extract assistant message
    const assistantMsg = chatResp.choices?.[0]?.message || {
      role: "assistant",
      content: "",
    };

    log.debug("收到上游响应", {
      content_len: assistantMsg.content?.length || 0,
      tool_calls_count: assistantMsg.tool_calls?.length || 0,
      usage: chatResp.usage,
    });

    // Save to session
    const fullHistory = [...chatReq.messages, assistantMsg];
    const responseId = sessions.save(fullHistory);

    log.info("阻塞请求完成", { responseId, model: codexModel });

    // Translate response
    const { response } = fromChatResponse(responseId, codexModel, chatResp);
    return Response.json(response);
  } catch (e) {
    log.error("上游请求异常", { error: String(e) });
    return new Response(String(e), { status: 502 });
  }
}

/// Strip trailing slash from URL if present.
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}