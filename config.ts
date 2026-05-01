import type { ChatMessage } from "./types.ts";
import { initLogger } from "./logger.ts";

// Configuration for codex-relay, loaded from a JSON file.
// Environment variables provide fallback defaults.

export interface LogConfigJson {
  level?: "debug" | "info" | "warn" | "error";
  truncate_length?: number;
}

export interface UserConfig {
  name: string;
  api_key: string;
  usage_limit?: number;  // tokens, undefined means no limit
}

export interface ConfigJson {
  upstream?: string;
  api_key?: string;
  fallback_api_key?: string;
  model_mapping?: Record<string, string>;
  log?: LogConfigJson;
  users?: UserConfig[];
  data_dir?: string;
}

export class Config {
  upstream: string;
  apiKey: string;
  fallbackApiKey: string;
  modelMapping: Record<string, string>;
  logLevel: "debug" | "info" | "warn" | "error";
  logTruncateLength: number;
  users: Map<string, UserConfig>;  // api_key -> UserConfig
  dataDir: string;

  constructor(
    upstream: string,
    apiKey: string,
    fallbackApiKey: string = "",
    modelMapping: Record<string, string> = {},
    users: UserConfig[] = [],
    dataDir: string = "./data",
    logLevel: "debug" | "info" | "warn" | "error" = "info",
    logTruncateLength: number = 200
  ) {
    this.upstream = upstream;
    this.apiKey = apiKey;
    this.fallbackApiKey = fallbackApiKey;
    this.modelMapping = modelMapping;
    this.users = new Map(users.map(u => [u.api_key, u]));
    this.dataDir = dataDir;
    this.logLevel = logLevel;
    this.logTruncateLength = logTruncateLength;
  }

  /// Get user by their API key
  getUserByApiKey(apiKey: string): UserConfig | undefined {
    return this.users.get(apiKey);
  }

  /// Check if fallback API key is configured
  hasFallback(): boolean {
    return !!this.fallbackApiKey && this.fallbackApiKey.length > 0;
  }

  /// Load configuration from a JSON file, with environment variable fallbacks.
  static load(configPath?: string): Config {
    const path = configPath || Deno.env.get("CODEX_RELAY_CONFIG") || "./relay-config.json";

    let json: ConfigJson = {};

    // Try to load JSON file
    try {
      const content = Deno.readTextFileSync(path);
      json = JSON.parse(content);
    } catch {
      // File not found or invalid JSON, use defaults
    }

    // Environment variable fallbacks
    const upstream = json.upstream ||
      Deno.env.get("CODEX_RELAY_UPSTREAM") ||
      "https://openrouter.ai/api/v1";

    const apiKey = json.api_key ||
      Deno.env.get("CODEX_RELAY_API_KEY") ||
      "";

    const fallbackApiKey = json.fallback_api_key ||
      Deno.env.get("CODEX_RELAY_FALLBACK_API_KEY") ||
      "";

    const modelMapping = json.model_mapping || {};

    const users = json.users || [];

    const dataDir = json.data_dir ||
      Deno.env.get("CODEX_RELAY_DATA_DIR") ||
      "./data";

    const logLevel = json.log?.level ||
      (Deno.env.get("LOG_LEVEL") as "debug" | "info" | "warn" | "error") ||
      "info";

    const logTruncateLength = json.log?.truncate_length ||
      parseInt(Deno.env.get("LOG_TRUNCATE_LENGTH") || "200");

    // 初始化 logger
    initLogger({ level: logLevel, truncate_length: logTruncateLength });

    return new Config(
      upstream,
      apiKey,
      fallbackApiKey,
      modelMapping,
      users,
      dataDir,
      logLevel,
      logTruncateLength
    );
  }

  /// Map a Codex model name to the upstream provider's model name.
  toUpstream(codexName: string): string {
    return this.modelMapping[codexName] || codexName;
  }

  /// Map an upstream provider model name back to the Codex model name.
  toCodex(upstreamName: string): string {
    for (const [codex, upstream] of Object.entries(this.modelMapping)) {
      if (upstream === upstreamName) {
        return codex;
      }
    }
    return upstreamName;
  }
}

// In-memory session store using a Map
// Maps response_id → accumulated message history for multi-turn conversations.
// Also maintains call_id → reasoning_content for thinking-capable models.
export class SessionStore {
  private sessions: Map<string, ChatMessage[]> = new Map();
  private reasoning: Map<string, string> = new Map();
  private turnReasoning: Map<string, string> = new Map();

  /// Store reasoning_content keyed by the tool call_id
  storeReasoning(callId: string, reasoning: string): void {
    if (reasoning && reasoning.length > 0) {
      this.reasoning.set(callId, reasoning);
    }
  }

  /// Look up stored reasoning_content for a call_id
  getReasoning(callId: string): string | undefined {
    return this.reasoning.get(callId);
  }

  /// Store reasoning_content for an assistant turn, keyed by content hash
  storeTurnReasoning(
    _prior: ChatMessage[],
    assistant: ChatMessage,
    reasoning: string
  ): void {
    if (!reasoning || reasoning.length === 0) return;

    const content = assistant.content || "";
    if (content.length > 0) {
      const key = this.contentKey(content);
      this.turnReasoning.set(key, reasoning);
    }

    // Also store under each tool call_id
    if (assistant.tool_calls) {
      for (const tc of assistant.tool_calls) {
        const id = (tc as Record<string, unknown>)?.id as string;
        if (id && id.length > 0) {
          this.storeReasoning(id, reasoning);
        }
      }
    }
  }

  /// Look up reasoning_content for an assistant turn by its text content
  getTurnReasoning(_prior: ChatMessage[], assistant: ChatMessage): string | undefined {
    const content = assistant.content || "";
    if (!content || content.length === 0) return undefined;

    const key = this.contentKey(content);
    return this.turnReasoning.get(key);
  }

  /// Hash assistant message content for turn-level reasoning lookup
  private contentKey(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /// Retrieve history for a prior response_id, or empty array if not found
  getHistory(responseId: string): ChatMessage[] {
    return this.sessions.get(responseId) || [];
  }

  /// Allocate a fresh response_id without storing anything yet
  newId(): string {
    return `resp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /// Store under a pre-allocated response_id (streaming path)
  saveWithId(id: string, messages: ChatMessage[]): void {
    this.sessions.set(id, messages);
  }

  /// Allocate an id and store atomically (non-streaming path)
  save(messages: ChatMessage[]): string {
    const id = this.newId();
    this.sessions.set(id, messages);
    return id;
  }
}