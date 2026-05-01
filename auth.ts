import type { Config, UserConfig } from "./config.ts";
import type { UserUsage } from "./types.ts";
import { UsageStore } from "./usage.ts";
import { createModuleLogger } from "./logger.ts";

const log = createModuleLogger("auth");

export interface AuthError {
  code: string;
  message: string;
  status: number;
}

export interface AuthResult {
  success: boolean;
  user?: UserConfig;
  error?: AuthError;
  usageInfo?: { limit: number; used: number; remaining: number };
}

/// Extract API key from Authorization header
function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return null;
  }

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Also support direct key (some clients may not use Bearer prefix)
  return authHeader;
}

/// Authenticate request and check usage limit
export async function authenticateRequest(
  req: Request,
  config: Config,
  usageStore: UsageStore
): Promise<AuthResult> {
  // 1. Extract API key
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    log.warn("缺少 API key", { path: new URL(req.url).pathname });
    return {
      success: false,
      error: { code: "missing_api_key", message: "API key required", status: 401 },
    };
  }

  // 2. Find user by API key
  const user = config.getUserByApiKey(apiKey);
  if (!user) {
    log.warn("无效的 API key", { api_key_prefix: apiKey.substring(0, 8) + "..." });
    return {
      success: false,
      error: { code: "invalid_api_key", message: "Invalid API key", status: 401 },
    };
  }

  log.debug("用户认证成功", { user: user.name });

  // 3. Check usage limit (if configured)
  if (user.usage_limit) {
    const { exceeded, usage } = await usageStore.checkLimit(user);
    if (exceeded) {
      log.warn("用户用量超限", {
        user: user.name,
        total: usage.total_tokens,
        limit: user.usage_limit,
      });
      return {
        success: false,
        error: { code: "usage_limit_exceeded", message: "Usage limit exceeded", status: 429 },
        usageInfo: { limit: user.usage_limit, used: usage.total_tokens, remaining: 0 },
      };
    }

    // Return usage info for successful auth
    const remaining = user.usage_limit - usage.total_tokens;
    return {
      success: true,
      user,
      usageInfo: { limit: user.usage_limit, used: usage.total_tokens, remaining },
    };
  }

  // No limit configured, auth successful
  return { success: true, user };
}

/// Create error response for auth failure
export function authErrorResponse(error: AuthError): Response {
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    { status: error.status }
  );
}