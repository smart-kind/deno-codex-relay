use dashmap::DashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::types::ChatMessage;

/// Maps response_id → accumulated message history for that session.
/// Codex uses `previous_response_id` to continue a conversation; we maintain
/// the full messages[] here so each Chat Completions call is self-contained.
///
/// Also maintains call_id → reasoning_content so that thinking-capable models
/// (e.g. kimi-k2.6) can have their reasoning_content round-tripped back when
/// Codex replays tool-call history in subsequent requests.
#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<DashMap<String, Vec<ChatMessage>>>,
    reasoning: Arc<DashMap<String, String>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(DashMap::new()),
            reasoning: Arc::new(DashMap::new()),
        }
    }

    /// Store reasoning_content keyed by the tool call_id so it can be
    /// injected back when the same call_id appears in a subsequent request.
    pub fn store_reasoning(&self, call_id: String, reasoning: String) {
        if !reasoning.is_empty() {
            self.reasoning.insert(call_id, reasoning);
        }
    }

    /// Look up stored reasoning_content for a call_id.
    pub fn get_reasoning(&self, call_id: &str) -> Option<String> {
        self.reasoning.get(call_id).map(|v| v.clone())
    }

    /// Retrieve history for a prior response_id, or empty vec if not found.
    pub fn get_history(&self, response_id: &str) -> Vec<ChatMessage> {
        self.inner
            .get(response_id)
            .map(|v| v.clone())
            .unwrap_or_default()
    }

    /// Allocate a fresh response_id without storing anything yet.
    /// Use with save_with_id() for the streaming path.
    pub fn new_id(&self) -> String {
        format!("resp_{}", Uuid::new_v4().simple())
    }

    /// Store under a pre-allocated response_id (streaming path).
    pub fn save_with_id(&self, id: String, messages: Vec<ChatMessage>) {
        self.inner.insert(id, messages);
    }

    /// Allocate an id and store atomically (non-streaming path).
    pub fn save(&self, messages: Vec<ChatMessage>) -> String {
        let id = self.new_id();
        self.inner.insert(id.clone(), messages);
        id
    }
}
