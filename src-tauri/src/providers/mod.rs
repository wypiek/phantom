//! AI provider abstraction.
//!
//! A provider turns a [`ProviderRequest`] into a stream of [`ProviderEvent`]s.
//! Adding a provider = a new module with a `run` function of the same shape
//! plus an arm in [`run`]. Providers never touch storage or the UI; the chat
//! orchestrator in `chat.rs` does that.

pub mod claude_code;
pub mod groq;
pub mod openrouter;

/// OpenAI-style user content: plain text, or text + image parts.
pub fn user_content(text: &str, images: &[String]) -> serde_json::Value {
    if images.is_empty() {
        return serde_json::json!(text);
    }
    let mut parts = vec![serde_json::json!({ "type": "text", "text": text })];
    for url in images {
        parts.push(serde_json::json!({ "type": "image_url", "image_url": { "url": url } }));
    }
    serde_json::Value::Array(parts)
}

use crate::settings::{ProviderKind, Settings};
use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ProviderRequest {
    pub conversation_id: String,
    pub system_prompt: String,
    /// Prior completed turns (oldest first), not including `user_message`.
    pub history: Vec<ChatTurn>,
    pub user_message: String,
    /// Claude Code session to resume, if the agent already holds this context.
    pub resume_session: Option<String>,
    /// Images (data URLs) attached to `user_message`, e.g. a screenshot.
    pub user_images: Vec<String>,
    pub settings: Settings,
}

/// Something the agent is doing (tool call, status line, permission request).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    /// "tool" | "status" | "permission"
    pub kind: String,
    pub label: String,
    pub detail: Option<String>,
    /// "running" | "done" | "error" | "denied" | "info"
    pub state: String,
}

#[derive(Debug, Clone)]
pub enum ProviderEvent {
    Delta(String),
    Activity(Activity),
    SessionId(String),
    Model(String),
}

pub type EventSink = UnboundedSender<ProviderEvent>;

#[derive(Debug, Default)]
pub struct Outcome {
    pub model: Option<String>,
    pub session_id: Option<String>,
}

pub fn kind_id(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::ClaudeCode => "claude-code",
        ProviderKind::Openrouter => "openrouter",
        ProviderKind::Groq => "groq",
    }
}

pub async fn run(
    kind: ProviderKind,
    ctx: &ProviderContext,
    req: ProviderRequest,
    sink: EventSink,
    cancel: CancellationToken,
) -> anyhow::Result<Outcome> {
    match kind {
        ProviderKind::Openrouter => openrouter::run(ctx, req, sink, cancel).await,
        ProviderKind::ClaudeCode => claude_code::run(ctx, req, sink, cancel).await,
        ProviderKind::Groq => groq::run(ctx, req, sink, cancel).await,
    }
}

/// Process-wide resources providers may use.
#[derive(Clone)]
pub struct ProviderContext {
    pub http: reqwest::Client,
    pub env_path: Option<String>,
    pub default_workspace: std::path::PathBuf,
    pub permission_bridge: Option<crate::permission::BridgeInfo>,
}

/// Renders prior turns as a transcript, used to seed a provider that did not
/// see the earlier part of a conversation (e.g. after switching providers).
pub fn transcript(history: &[ChatTurn], max_chars: usize) -> String {
    let mut lines: Vec<String> = history
        .iter()
        .map(|t| format!("{}: {}", if t.role == "user" { "User" } else { "Noli" }, t.content.trim()))
        .collect();
    // keep the most recent part if too long
    let mut total: usize = lines.iter().map(|l| l.len() + 2).sum();
    while total > max_chars && lines.len() > 1 {
        total -= lines[0].len() + 2;
        lines.remove(0);
    }
    lines.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_keeps_recent() {
        let h = vec![
            ChatTurn { role: "user".into(), content: "a".repeat(50) },
            ChatTurn { role: "assistant".into(), content: "b".repeat(50) },
            ChatTurn { role: "user".into(), content: "latest".into() },
        ];
        let t = transcript(&h, 80);
        assert!(t.contains("latest"));
        assert!(!t.contains("aaaa"));
        assert!(transcript(&h, 10_000).starts_with("User: aaa"));
    }
}
