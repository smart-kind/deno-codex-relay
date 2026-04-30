use std::collections::HashMap;
use serde::Deserialize;

/// Configuration for codex-relay, loaded from a JSON file.
/// Environment variables provide fallback defaults.
#[derive(Debug, Default, Deserialize)]
pub struct Config {
    /// Upstream API base URL. Default: https://openrouter.ai/api/v1 (from env CODEX_RELAY_UPSTREAM)
    #[serde(default)]
    pub upstream: Option<String>,

    /// API key for upstream provider. Default: empty (from env CODEX_RELAY_API_KEY)
    #[serde(default)]
    pub api_key: Option<String>,

    /// Mapping from Codex model names to upstream provider model names.
    /// Used bidirectionally: forward for requests, reverse for responses.
    #[serde(default)]
    pub model_mapping: HashMap<String, String>,
}

impl Config {
    /// Load configuration from a JSON file.
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&content)?)
    }

    /// Map a Codex model name to the upstream provider's model name.
    /// Returns the original name if no mapping is defined.
    pub fn to_upstream(&self, codex_name: &str) -> String {
        self.model_mapping
            .get(codex_name)
            .cloned()
            .unwrap_or_else(|| codex_name.to_string())
    }

    /// Map an upstream provider model name back to the Codex model name.
    /// Returns the original name if no mapping is defined.
    pub fn to_codex(&self, upstream_name: &str) -> String {
        // Check for explicit reverse mapping (if user provides one)
        for (codex, upstream) in &self.model_mapping {
            if upstream == upstream_name {
                return codex.clone();
            }
        }
        upstream_name.to_string()
    }

    /// Check if any model mapping is configured.
    pub fn is_empty(&self) -> bool {
        self.model_mapping.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config() -> Config {
        Config {
            upstream: Some("https://api.deepseek.com".to_string()),
            api_key: Some("test-key".to_string()),
            model_mapping: HashMap::from([
                ("gpt-5.4-mini".to_string(), "deepseek-v4-pro".to_string()),
                ("gpt-5.5".to_string(), "deepseek-chat".to_string()),
            ]),
        }
    }

    #[test]
    fn test_to_upstream_mapped() {
        let config = make_config();
        assert_eq!(config.to_upstream("gpt-5.4-mini"), "deepseek-v4-pro");
        assert_eq!(config.to_upstream("gpt-5.5"), "deepseek-chat");
    }

    #[test]
    fn test_to_upstream_unmapped_returns_original() {
        let config = make_config();
        assert_eq!(config.to_upstream("unknown-model"), "unknown-model");
    }

    #[test]
    fn test_to_codex_reverse_mapped() {
        let config = make_config();
        assert_eq!(config.to_codex("deepseek-v4-pro"), "gpt-5.4-mini");
        assert_eq!(config.to_codex("deepseek-chat"), "gpt-5.5");
    }

    #[test]
    fn test_to_codex_unmapped_returns_original() {
        let config = make_config();
        assert_eq!(config.to_codex("unknown-model"), "unknown-model");
    }

    #[test]
    fn test_empty_config_returns_original() {
        let config = Config::default();
        assert_eq!(config.to_upstream("gpt-5.4-mini"), "gpt-5.4-mini");
        assert_eq!(config.to_codex("deepseek-v4-pro"), "deepseek-v4-pro");
        assert!(config.is_empty());
    }

    #[test]
    fn test_load_json_file() {
        let json = r#"{"upstream": "https://api.test.com", "api_key": "my-key", "model_mapping": {"gpt-5.4-mini": "deepseek-v4-pro"}}"#;
        let config: Config = serde_json::from_str(json).unwrap();
        assert_eq!(config.upstream, Some("https://api.test.com".to_string()));
        assert_eq!(config.api_key, Some("my-key".to_string()));
        assert_eq!(config.to_upstream("gpt-5.4-mini"), "deepseek-v4-pro");
        assert!(!config.is_empty());
    }
}