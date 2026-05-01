// ── Responses API (inbound from Codex CLI) ──────────────────────────────────────

export interface ResponsesRequest {
  model: string;
  input: ResponsesInput;
  previous_response_id?: string;
  tools?: unknown[];
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  system?: string;
  instructions?: string;
}

// Responses input can be either a plain text string or an array of message items
export type ResponsesInput = string | unknown[];

export interface ContentPart {
  type: string;
  text?: string;
}

export interface ResponsesResponse {
  id: string;
  object: string;
  model: string;
  output: ResponsesOutputItem[];
  usage: ResponsesUsage;
}

export interface ResponsesOutputItem {
  type: string;
  role: string;
  content: ContentPart[];
}

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

// ── Chat Completions API (outbound to provider) ──────────────────────────────────

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  max_tokens?: number;
  stream: boolean;
}

export interface ChatMessage {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatResponse {
  choices: ChatChoice[];
  usage?: ChatUsage;
}

export interface ChatChoice {
  message: ChatMessage;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ── SSE streaming types ───────────────────────────────────────────────────────────

export interface ChatStreamChunk {
  choices: ChatStreamChoice[];
  usage?: ChatUsage;
}

export interface ChatStreamChoice {
  delta: ChatDelta;
  finish_reason?: string;
}

export interface ChatDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: DeltaToolCall[];
}

export interface DeltaToolCall {
  index: number;
  id?: string;
  function?: DeltaFunction;
}

export interface DeltaFunction {
  name?: string;
  arguments?: string;
}

// ── SSE event types for Responses API ────────────────────────────────────────────

export interface SSEEvent {
  event: string;
  data: string;
}

// ── Usage tracking types ────────────────────────────────────────────────────────────

export interface UsageRecord {
  user: string;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  model: string;
  upstream_model: string;
  link_type: "primary" | "fallback";
  request_id: string;
  fallback_reason?: string;
}

export interface UserUsage {
  user: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  total_requests: number;
  primary_tokens: number;
  fallback_tokens: number;
  last_updated: string;
}

export interface ChatLogEntry {
  timestamp: string;
  user: string;
  request_id: string;
  model: string;
  upstream_model: string;
  link_type: "primary" | "fallback";
  request: unknown;
  response: unknown;
  usage?: { input_tokens: number; output_tokens: number };
  fallback_reason?: string;
}

export interface SystemErrorEntry {
  timestamp: string;
  type: "upstream_error" | "model_mapping_missing" | "unexpected_exception";
  error: string;
  upstream?: string;
  model?: string;
  request_id?: string;
  user?: string;
  stack?: string;
  context?: string;
}