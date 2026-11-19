//! Groq provider (OpenAI-compatible chat completions with SSE streaming).
//! https://console.groq.com/docs/api-reference
//!
//! Groq provides ultra-fast inference on open models. The API is OpenAI-
//! compatible, so we reuse the SSE parser from the OpenRouter module.

use super::{EventSink, Outcome, ProviderContext, ProviderEvent, ProviderRequest};
use crate::secrets;
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

// Reuse the SSE parser and message builder from the openrouter module.
use super::openrouter::{SseParser, SseItem};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroqModelInfo {
    pub id: String,
    pub owned_by: Option<String>,
    pub context_window: Option<u64>,
    pub active: bool,
}

fn api_key() -> Result<String> {
    secrets::get(secrets::GROQ_KEY)?
        .ok_or_else(|| anyhow!("No Groq API key configured. Add one in Settings → AI Provider."))
}

fn base(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

pub fn parse_models(body: &Value) -> Vec<GroqModelInfo> {
    let mut out: Vec<GroqModelInfo> = body["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some(GroqModelInfo {
                        id: m["id"].as_str()?.to_string(),
                        owned_by: m["owned_by"].as_str().map(|s| s.to_string()),
                        context_window: m["context_window"].as_u64(),
                        active: m["active"].as_bool().unwrap_or(true),
                    })
                })
                .filter(|m| m.active)
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub async fn list_models(ctx: &ProviderContext, base_url: &str) -> Result<Vec<GroqModelInfo>> {
    let key = api_key()?;
    let resp = ctx
        .http
        .get(format!("{}/models", base(base_url)))
        .bearer_auth(&key)
        .send()
        .await
        .context("could not reach Groq")?;
    if !resp.status().is_success() {
        return Err(anyhow!("Groq returned {} while listing models", resp.status()));
    }
    let body: Value = resp.json().await?;
    Ok(parse_models(&body))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    pub ok: bool,
    pub message: String,
}

/// Validates a key by listing models (Groq has no /key endpoint like OpenRouter).
pub async fn test_key(ctx: &ProviderContext, base_url: &str, candidate: Option<&str>) -> Result<KeyCheck> {
    let key = match candidate {
        Some(k) if !k.trim().is_empty() => k.trim().to_string(),
        _ => api_key()?,
    };
    let resp = ctx
        .http
        .get(format!("{}/models", base(base_url)))
        .bearer_auth(&key)
        .send()
        .await
        .context("could not reach Groq — check your internet connection")?;
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Ok(KeyCheck { ok: false, message: "Groq rejected this API key.".into() });
    }
    if !status.is_success() {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        return Ok(KeyCheck { ok: false, message: error_message(status.as_u16(), &body) });
    }
    Ok(KeyCheck { ok: true, message: "Connected to Groq.".into() })
}

pub fn error_message(status: u16, body: &Value) -> String {
    let detail = body["error"]["message"]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let base = match status {
        400 => "Groq rejected the request",
        401 => "Groq rejected the API key",
        403 => "This request was blocked by Groq",
        404 => "That model was not found on Groq",
        408 => "Groq timed out",
        413 => "Request too large for Groq — reduce context or max tokens",
        429 => "Groq rate limit reached — wait a moment and retry",
        502 | 503 => "Groq is temporarily unavailable",
        _ => "Groq error",
    };
    if detail.is_empty() {
        format!("{base} (HTTP {status}).")
    } else {
        format!("{base}: {detail}")
    }
}

fn build_messages(req: &ProviderRequest) -> Vec<Value> {
    let mut messages = vec![json!({ "role": "system", "content": req.system_prompt })];
    for t in &req.history {
        messages.push(json!({ "role": t.role, "content": t.content }));
    }
    messages.push(json!({ "role": "user", "content": super::user_content(&req.user_message, &req.user_images) }));
    messages
}

pub async fn run(ctx: &ProviderContext, req: ProviderRequest, sink: EventSink, cancel: CancellationToken) -> Result<Outcome> {
    let cfg = req.settings.provider.groq.clone();
    let key = api_key()?;
    let model = cfg.model.trim().to_string();
    if model.is_empty() {
        return Err(anyhow!("Choose a Groq model in Settings → AI Provider."));
    }
    let body = json!({
        "model": model,
        "messages": build_messages(&req),
        "stream": true,
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
    });
    let send = ctx
        .http
        .post(format!("{}/chat/completions", base(&cfg.base_url)))
        .bearer_auth(&key)
        .json(&body)
        .send();
    let resp = tokio::select! {
        r = send => r.context("could not reach Groq — check your internet connection")?,
        _ = cancel.cancelled() => return Ok(Outcome { model: Some(model), session_id: None }),
    };
    let status = resp.status();
    if !status.is_success() {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        return Err(anyhow!(error_message(status.as_u16(), &body)));
    }
    let mut stream = resp.bytes_stream();
    let mut parser = SseParser::default();
    let mut used_model = Some(model);
    let mut utf8_carry: Vec<u8> = vec![];
    loop {
        let chunk = tokio::select! {
            c = stream.next() => c,
            _ = cancel.cancelled() => break,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.context("connection to Groq dropped")?;
        utf8_carry.extend_from_slice(&chunk);
        let valid_up_to = match std::str::from_utf8(&utf8_carry) {
            Ok(_) => utf8_carry.len(),
            Err(e) => e.valid_up_to(),
        };
        let text = String::from_utf8_lossy(&utf8_carry[..valid_up_to]).into_owned();
        utf8_carry.drain(..valid_up_to);
        for item in parser.push(&text) {
            match item {
                SseItem::Done => return Ok(Outcome { model: used_model, session_id: None }),
                SseItem::Data(d) => {
                    let Ok(v) = serde_json::from_str::<Value>(&d) else { continue };
                    if let Some(err) = v.get("error") {
                        let msg = err["message"].as_str().unwrap_or("stream error").to_string();
                        return Err(anyhow!("Groq: {msg}"));
                    }
                    if let Some(m) = v["model"].as_str() {
                        used_model = Some(m.to_string());
                    }
                    if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                        if !delta.is_empty() {
                            let _ = sink.send(ProviderEvent::Delta(delta.to_string()));
                        }
                    }
                    if v["choices"][0]["finish_reason"].as_str() == Some("error") {
                        return Err(anyhow!("The model stopped with an error."));
                    }
                }
            }
        }
    }
    Ok(Outcome { model: used_model, session_id: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_groq_models() {
        let body = json!({"data": [
            {"id": "llama-3.3-70b-versatile", "owned_by": "Meta", "context_window": 131072, "active": true},
            {"id": "deprecated-model", "owned_by": "Meta", "context_window": 8192, "active": false},
            {"id": "mixtral-8x7b-32768", "owned_by": "Mistral AI", "context_window": 32768, "active": true}
        ]});
        let m = parse_models(&body);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "llama-3.3-70b-versatile");
        assert_eq!(m[1].id, "mixtral-8x7b-32768");
    }

    #[test]
    fn error_messages_are_friendly() {
        assert!(error_message(429, &Value::Null).contains("rate limit"));
        let b = json!({"error": {"message": "Model not found"}});
        assert_eq!(error_message(404, &b), "That model was not found on Groq: Model not found");
    }
}
