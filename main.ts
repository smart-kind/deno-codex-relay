import { Config, SessionStore } from "./config.ts";
import type { UserConfig } from "./config.ts";
import { toChatRequest, fromChatResponse } from "./translate.ts";
import { translateStream } from "./stream.ts";
import { createModuleLogger } from "./logger.ts";
import { authenticateRequest, authErrorResponse } from "./auth.ts";
import { UsageStore } from "./usage.ts";
import { appendChatLog, appendSystemError } from "./persist.ts";
import type { ResponsesRequest, ChatRequest, ChatResponse, ChatLogEntry, SystemErrorEntry } from "./types.ts";

const log = createModuleLogger("main");

// Default port
const PORT = parseInt(Deno.env.get("CODEX_RELAY_PORT") || "7150");

// Global state
const config = Config.load();
const sessions = new SessionStore();
const usageStore = new UsageStore(config.dataDir);

log.info("服务器启动", {
  port: PORT,
  upstream: config.upstream,
  log_level: config.logLevel,
  users_count: config.users.size,
  has_fallback: config.hasFallback(),
  data_dir: config.dataDir,
});

Deno.serve({ port: PORT }, async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname;

  // Authentication for all routes (except health check if added later)
  const authResult = await authenticateRequest(req, config, usageStore);
  if (!authResult.success) {
    log.warn("认证失败", { path, error: authResult.error?.code });
    return authErrorResponse(authResult.error!);
  }
  const user = authResult.user!;

  // POST /v1/responses — main translation endpoint
  if (req.method === "POST" && path === "/v1/responses") {
    return handleResponses(req, user);
  }

  // GET /v1/models — proxy to upstream with model name mapping
  if (req.method === "GET" && path === "/v1/models") {
    return handleModels(user);
  }

  // GET /status — user's usage statistics
  if (req.method === "GET" && path === "/status") {
    return handleStatus(user);
  }

  // Fallback: 404
  log.warn("未知路径", { method: req.method, path, user: user.name });
  return new Response("not found", { status: 404 });
});

/// GET /v1/models — proxy to upstream and transform model names if mapping configured.
async function handleModels(user: UserConfig): Promise<Response> {
  log.debug("请求模型列表", { user: user.name });

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
    log.info("模型列表返回", { models_count: ((transformed as Record<string, unknown>)?.data as unknown[])?.length || 0 });
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
async function handleResponses(req: Request, user: UserConfig): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (e) {
    log.error("JSON 解析失败", { error: String(e), user: user.name });
    return new Response(String(e), { status: 422 });
  }

  const responsesReq = body as ResponsesRequest;
  log.info("收到请求", {
    model: responsesReq.model,
    stream: responsesReq.stream,
    input_type: typeof responsesReq.input,
    previous_response_id: responsesReq.previous_response_id,
    tools_count: responsesReq.tools?.length || 0,
    user: user.name,
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

  // Check if model mapping is missing (potential configuration issue)
  if (upstreamModel === codexModel && Object.keys(config.modelMapping).length > 0) {
    // Model not in mapping, but mapping is configured - might be intentional or missing
    log.debug("模型未映射", { codex_model: codexModel, user: user.name });
  } else if (upstreamModel !== codexModel) {
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

    log.debug("流式请求开始", { responseId, url, user: user.name });

    const stream = translateStream({
      url,
      apiKey: config.apiKey,
      fallbackApiKey: config.fallbackApiKey,
      chatReq,
      responseId,
      sessions,
      priorMessages: history,
      requestMessages,
      codexModel,
      upstreamModel,
      user,
      config,
      usageStore,
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
    return handleBlocking(chatReq, url, codexModel, upstreamModel, user);
  }
}

/// Handle blocking (non-streaming) request with Fallback support.
async function handleBlocking(
  chatReq: ChatRequest,
  url: string,
  codexModel: string,
  upstreamModel: string,
  user: UserConfig
): Promise<Response> {
  log.debug("阻塞请求开始", { url, model: chatReq.model, user: user.name });

  const responseId = sessions.newId();
  let linkType: "primary" | "fallback" = "primary";
  let fallbackReason: string | undefined;

  // Define interruptive error codes that trigger fallback
  const INTERRUPTIVE_STATUS_CODES = [502, 503, 504, 429];

  // Primary attempt
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  let resp: Response;
  let primaryError: { status: number; body: string } | null = null;

  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(chatReq),
    });

    if (!resp.ok) {
      primaryError = { status: resp.status, body: await resp.text().catch(() => "") };

      // Check if we should trigger fallback
      if (INTERRUPTIVE_STATUS_CODES.includes(resp.status) && config.hasFallback()) {
        log.warn("Primary 失败，切换 Fallback", {
          status: resp.status,
          user: user.name,
          model: codexModel,
        });

        // Fallback attempt
        const fallbackHeaders: Record<string, string> = { "Content-Type": "application/json" };
        fallbackHeaders["Authorization"] = `Bearer ${config.fallbackApiKey}`;

        try {
          resp = await fetch(url, {
            method: "POST",
            headers: fallbackHeaders,
            body: JSON.stringify(chatReq),
          });

          if (resp.ok) {
            linkType = "fallback";
            fallbackReason = `primary_${resp.status}`;
            log.info("Fallback 成功", { user: user.name, model: codexModel });
          } else {
            // Fallback also failed
            const fallbackBody = await resp.text().catch(() => "");
            log.error("Fallback 也失败", { status: resp.status, body: fallbackBody, user: user.name });

            // Record system error
            await recordSystemError("upstream_error", {
              error: `primary_${primaryError.status}, fallback_${resp.status}`,
              upstream: config.upstream,
              model: upstreamModel,
              request_id: responseId,
              user: user.name,
            });

            return new Response(fallbackBody, { status: resp.status });
          }
        } catch (fallbackErr) {
          log.error("Fallback 连接失败", { error: String(fallbackErr), user: user.name });

          await recordSystemError("upstream_error", {
            error: `primary_${primaryError.status}, fallback_${String(fallbackErr)}`,
            upstream: config.upstream,
            model: upstreamModel,
            request_id: responseId,
            user: user.name,
          });

          return new Response(String(fallbackErr), { status: 502 });
        }
      } else {
        // No fallback or non-interruptive error
        log.error("上游返回错误", { status: primaryError.status, body: primaryError.body, user: user.name });

        // Record system error for 5xx errors without fallback
        if (primaryError.status >= 500 && !config.hasFallback()) {
          await recordSystemError("upstream_error", {
            error: `${primaryError.status}: ${primaryError.body}`,
            upstream: config.upstream,
            model: upstreamModel,
            request_id: responseId,
            user: user.name,
          });
        }

        return new Response(primaryError.body, { status: primaryError.status });
      }
    }
  } catch (e) {
    log.error("上游请求异常", { error: String(e), user: user.name });

    // Network error - try fallback if available
    if (config.hasFallback()) {
      log.warn("Primary 连接异常，切换 Fallback", { user: user.name, model: codexModel });

      const fallbackHeaders: Record<string, string> = { "Content-Type": "application/json" };
      fallbackHeaders["Authorization"] = `Bearer ${config.fallbackApiKey}`;

      try {
        resp = await fetch(url, {
          method: "POST",
          headers: fallbackHeaders,
          body: JSON.stringify(chatReq),
        });

        if (resp.ok) {
          linkType = "fallback";
          fallbackReason = "primary_connection_error";
          log.info("Fallback 成功", { user: user.name, model: codexModel });
        } else {
          const fallbackBody = await resp.text().catch(() => "");
          log.error("Fallback 也失败", { status: resp.status, user: user.name });

          await recordSystemError("upstream_error", {
            error: `primary_connection_error, fallback_${resp.status}`,
            upstream: config.upstream,
            model: upstreamModel,
            request_id: responseId,
            user: user.name,
          });

          return new Response(fallbackBody, { status: resp.status });
        }
      } catch (fallbackErr) {
        log.error("Fallback 连接也异常", { error: String(fallbackErr), user: user.name });

        await recordSystemError("upstream_error", {
          error: `primary_connection_error, fallback_${String(fallbackErr)}`,
          upstream: config.upstream,
          model: upstreamModel,
          request_id: responseId,
          user: user.name,
        });

        return new Response(String(fallbackErr), { status: 502 });
      }
    } else {
      await recordSystemError("upstream_error", {
        error: String(e),
        upstream: config.upstream,
        model: upstreamModel,
        request_id: responseId,
        user: user.name,
      });

      return new Response(String(e), { status: 502 });
    }
  }

  // Parse successful response
  let chatResp: ChatResponse;
  try {
    chatResp = await resp.json();
  } catch (e) {
    log.error("响应 JSON 解析失败", { error: String(e), user: user.name });
    return new Response("Invalid JSON response", { status: 502 });
  }

  // Extract assistant message
  const assistantMsg = chatResp.choices?.[0]?.message || {
    role: "assistant",
    content: "",
  };

  log.debug("收到上游响应", {
    content_len: assistantMsg.content?.length || 0,
    tool_calls_count: assistantMsg.tool_calls?.length || 0,
    usage: chatResp.usage,
    link_type: linkType,
    user: user.name,
  });

  // Save to session
  const fullHistory = [...chatReq.messages, assistantMsg];
  sessions.saveWithId(responseId, fullHistory);

  log.info("阻塞请求完成", { responseId, model: codexModel, link_type: linkType, user: user.name });

  // Record usage
  const usage = chatResp.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  await usageStore.recordUsage({
    user: user.name,
    timestamp: new Date().toISOString(),
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
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
    request: responsesReqFromChatReq(chatReq),
    response: chatResp,
    usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
    fallback_reason: fallbackReason,
  };
  await appendChatLog(config.dataDir, user.name, chatLogEntry);

  // Translate response
  const { response } = fromChatResponse(responseId, codexModel, chatResp);
  return Response.json(response);
}

/// Helper: Record system error
async function recordSystemError(
  type: SystemErrorEntry["type"],
  details: { error: string; upstream?: string; model?: string; request_id?: string; user?: string }
): Promise<void> {
  try {
    const entry: SystemErrorEntry = {
      timestamp: new Date().toISOString(),
      type,
      error: details.error,
      upstream: details.upstream,
      model: details.model,
      request_id: details.request_id,
      user: details.user,
    };
    await appendSystemError(config.dataDir, entry);
  } catch (e) {
    log.error("记录系统错误失败", { error: String(e) });
  }
}

/// Helper: Extract request info for chat log (simplified)
function responsesReqFromChatReq(chatReq: ChatRequest): unknown {
  return {
    model: chatReq.model,
    messages: chatReq.messages,
    stream: chatReq.stream,
  };
}

/// GET /status — return user's usage statistics
async function handleStatus(user: UserConfig): Promise<Response> {
  const usage = await usageStore.getUserUsage(user.name);
  const limit = user.usage_limit;

  log.debug("状态查询", { user: user.name, total_tokens: usage.total_tokens });

  return Response.json({
    user: user.name,
    usage: {
      total_tokens: usage.total_tokens,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_requests: usage.total_requests,
      primary_tokens: usage.primary_tokens,
      fallback_tokens: usage.fallback_tokens,
    },
    limit: limit || null,
    remaining: limit ? Math.max(0, limit - usage.total_tokens) : null,
    last_updated: usage.last_updated,
  });
}

/// Strip trailing slash from URL if present.
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}