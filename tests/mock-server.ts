/**
 * Mock upstream server for testing fallback and error scenarios
 */

export interface MockServerConfig {
  port: number;
  statusCode: number;
  responseBody: object | string;
  streamChunks?: string[]; // For SSE streaming
  delayMs?: number; // Response delay
}

export interface MockRequestLog {
  timestamp: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * MockUpstreamServer - Simulates upstream API for testing
 *
 * Usage:
 * ```typescript
 * const mock = new MockUpstreamServer({ port: 9999, statusCode: 200, responseBody: {...} });
 * mock.start();
 * // ... make requests to http://localhost:9999
 * mock.stop();
 * ```
 */
export class MockUpstreamServer {
  private server: Deno.HttpServer | null = null;
  private config: MockServerConfig;
  private requestLog: MockRequestLog[] = [];
  private requestCount = 0;

  constructor(config: MockServerConfig) {
    this.config = config;
  }

  /**
   * Update response configuration (for dynamic testing)
   */
  setResponse(statusCode: number, responseBody: object | string, streamChunks?: string[]) {
    this.config.statusCode = statusCode;
    this.config.responseBody = responseBody;
    if (streamChunks) {
      this.config.streamChunks = streamChunks;
    }
  }

  /**
   * Get logged requests
   */
  getRequests(): MockRequestLog[] {
    return [...this.requestLog];
  }

  /**
   * Get request count
   */
  getRequestCount(): number {
    return this.requestCount;
  }

  /**
   * Clear request log
   */
  clearLog(): void {
    this.requestLog = [];
    this.requestCount = 0;
  }

  /**
   * Start the mock server
   */
  async start(): Promise<void> {
    this.server = Deno.serve({ port: this.config.port }, (req) => this.handleRequest(req));
  }

  /**
   * Stop the mock server
   */
  async stop(): Promise<void> {
    if (this.server) {
      await this.server.shutdown();
      this.server = null;
    }
  }

  /**
   * Get server URL
   */
  getUrl(): string {
    return `http://localhost:${this.config.port}`;
  }

  private async handleRequest(req: Request): Promise<Response> {
    // Log request
    const logEntry: MockRequestLog = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: new URL(req.url).pathname,
      headers: Object.fromEntries(req.headers.entries()),
      body: null,
    };

    // Parse body if present
    if (req.method === "POST") {
      try {
        const text = await req.text();
        logEntry.body = text ? JSON.parse(text) : null;
      } catch {
        logEntry.body = await req.text();
      }
    }

    this.requestLog.push(logEntry);
    this.requestCount++;

    // Apply delay if configured
    if (this.config.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
    }

    // Handle streaming request
    const body = logEntry.body as { stream?: boolean } | null;
    if (body?.stream && this.config.streamChunks) {
      return this.handleStreamRequest();
    }

    // Handle blocking request
    return this.handleBlockingRequest();
  }

  private handleBlockingRequest(): Response {
    const body = typeof this.config.responseBody === "string"
      ? this.config.responseBody
      : JSON.stringify(this.config.responseBody);

    return new Response(body, {
      status: this.config.statusCode,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  private handleStreamRequest(): Response {
    const chunks = this.config.streamChunks || [];

    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
          // Small delay between chunks for realistic streaming
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: this.config.statusCode,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }
}

/**
 * Helper: Create mock chat completions response
 */
export function mockChatResponse(text: string, model: string = "mock-model"): object {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: Date.now(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
  };
}

/**
 * Helper: Create mock SSE chunks for streaming
 */
export function mockStreamChunks(text: string, model: string = "mock-model"): string[] {
  const chunks: string[] = [];

  // Start
  chunks.push(`data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":${Date.now},"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`);

  // Content delta
  for (const char of text) {
    chunks.push(`data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":${Date.now},"model":"${model}","choices":[{"index":0,"delta":{"content":"${char}"},"finish_reason":null}]}\n\n`);
  }

  // Finish
  chunks.push(`data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":${Date.now},"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);

  // Done
  chunks.push("data: [DONE]\n\n");

  return chunks;
}

/**
 * Helper: Create mock models response
 */
export function mockModelsResponse(models: string[] = ["mock-model", "mock-model-2"]): object {
  return {
    object: "list",
    data: models.map((id) => ({
      id,
      object: "model",
      owned_by: "mock-provider",
    })),
  };
}

/**
 * Helper: Create error response
 */
export function mockErrorResponse(errorType: string, message: string): object {
  return {
    error: {
      type: errorType,
      message,
    },
  };
}