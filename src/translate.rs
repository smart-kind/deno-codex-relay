use serde_json::{json, Value};

use crate::types::*;

/// Convert a Responses API request + prior history into a Chat Completions request.
pub fn to_chat_request(req: &ResponsesRequest, history: Vec<ChatMessage>) -> ChatRequest {
    let mut messages = history;

    // Prefer `instructions` (Codex CLI) over `system` (other clients).
    let system_text = req.instructions.as_ref().or(req.system.as_ref());
    if let Some(system) = system_text {
        if messages.is_empty() || messages[0].role != "system" {
            messages.insert(
                0,
                ChatMessage {
                    role: "system".into(),
                    content: Some(system.clone()),
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                },
            );
        }
    }

    // Append new input, mapping Responses API roles to Chat Completions roles.
    match &req.input {
        ResponsesInput::Text(text) => {
            messages.push(ChatMessage {
                role: "user".into(),
                content: Some(text.clone()),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            });
        }
        ResponsesInput::Messages(items) => {
            for item in items {
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match item_type {
                    "function_call" => {
                        // Tool call issued by the assistant in a prior turn.
                        // Codex includes it inline in subsequent requests so the full
                        // conversation history is self-contained. Map to a Chat Completions
                        // assistant message with a tool_calls array.
                        let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let arguments = item.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                        messages.push(ChatMessage {
                            role: "assistant".into(),
                            content: None,
                            tool_calls: Some(vec![json!({
                                "id": call_id,
                                "type": "function",
                                "function": { "name": name, "arguments": arguments }
                            })]),
                            tool_call_id: None,
                            name: None,
                        });
                    }
                    "function_call_output" => {
                        let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                        let output = item.get("output").and_then(|v| v.as_str()).unwrap_or("");
                        messages.push(ChatMessage {
                            role: "tool".into(),
                            content: Some(output.to_string()),
                            tool_calls: None,
                            tool_call_id: Some(call_id.to_string()),
                            name: None,
                        });
                    }
                    _ => {
                        // Regular user/assistant/developer message
                        let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                        let role = match role {
                            "developer" => "system",
                            other => other,
                        }
                        .to_string();
                        let content = value_to_text(item.get("content"));
                        messages.push(ChatMessage {
                            role,
                            content: Some(content),
                            tool_calls: None,
                            tool_call_id: None,
                            name: None,
                        });
                    }
                }
            }
        }
    }

    ChatRequest {
        model: req.model.clone(),
        messages,
        // Keep only `function` tools; providers like DeepSeek don't accept
        // OpenAI-proprietary built-ins (web_search, computer, file_search, …).
        tools: req.tools.iter()
            .filter(|t| t.get("type").and_then(Value::as_str) == Some("function"))
            .map(convert_tool)
            .collect(),
        temperature: req.temperature,
        max_tokens: req.max_output_tokens,
        stream: req.stream,
    }
}

/// Responses API tool format → Chat Completions tool format.
///
/// Responses API (flat):
///   {"type":"function","name":"foo","description":"...","parameters":{...},"strict":false}
///
/// Chat Completions (nested):
///   {"type":"function","function":{"name":"foo","description":"...","parameters":{...}}}
fn convert_tool(tool: &Value) -> Value {
    let Some(obj) = tool.as_object() else {
        return tool.clone();
    };
    // Already in Chat Completions format if it has a "function" sub-object.
    if obj.contains_key("function") {
        return tool.clone();
    }
    // Convert from Responses API flat format.
    if obj.get("type").and_then(Value::as_str) == Some("function") {
        let mut func = serde_json::Map::new();
        if let Some(v) = obj.get("name") { func.insert("name".into(), v.clone()); }
        if let Some(v) = obj.get("description") { func.insert("description".into(), v.clone()); }
        if let Some(v) = obj.get("parameters") { func.insert("parameters".into(), v.clone()); }
        if let Some(v) = obj.get("strict") { func.insert("strict".into(), v.clone()); }
        return json!({"type": "function", "function": func});
    }
    tool.clone()
}

/// Convert a Chat Completions response into a Responses API response.
pub fn from_chat_response(
    id: String,
    model: &str,
    chat: ChatResponse,
) -> (ResponsesResponse, Vec<ChatMessage>) {
    let choice = chat.choices.into_iter().next().unwrap_or_else(|| ChatChoice {
        message: ChatMessage {
            role: "assistant".into(),
            content: Some(String::new()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        },
    });

    let text = choice.message.content.clone().unwrap_or_default();
    let usage = chat.usage.unwrap_or(ChatUsage {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
    });

    let response = ResponsesResponse {
        id,
        object: "response",
        model: model.to_string(),
        output: vec![ResponsesOutputItem {
            kind: "message".into(),
            role: "assistant".into(),
            content: vec![ContentPart {
                kind: "output_text".into(),
                text: Some(text),
            }],
        }],
        usage: ResponsesUsage {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
        },
    };

    (response, vec![choice.message])
}

/// Collapse a Responses API content value (string or parts array) to plain text.
fn value_to_text(v: Option<&Value>) -> String {
    match v {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        Some(other) => other.to_string(),
    }
}
