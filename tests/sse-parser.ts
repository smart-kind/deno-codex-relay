/**
 * SSE (Server-Sent Events) parser helper for testing
 */

export interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * Parse SSE text content into events array
 */
export function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const lines = text.split("\n");

  let currentEvent: SSEEvent | null = null;

  for (const line of lines) {
    if (line.startsWith("event:")) {
      if (currentEvent) {
        events.push(currentEvent);
      }
      currentEvent = { event: line.slice(6).trim(), data: "" };
    } else if (line.startsWith("data:")) {
      if (currentEvent) {
        currentEvent.data = line.slice(5).trim();
      } else {
        events.push({ data: line.slice(5).trim() });
      }
    } else if (line === "" && currentEvent) {
      events.push(currentEvent);
      currentEvent = null;
    }
  }

  if (currentEvent) {
    events.push(currentEvent);
  }

  return events;
}

/**
 * Extract text content from SSE events
 */
export function extractTextFromSSE(events: SSEEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.data && event.data !== "[DONE]") {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.choices?.[0]?.delta?.content) {
          text += parsed.choices[0].delta.content;
        }
      } catch {
        // Skip non-JSON data
      }
    }
  }
  return text;
}