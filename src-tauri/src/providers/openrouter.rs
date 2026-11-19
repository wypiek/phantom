//! OpenRouter provider (OpenAI-compatible chat completions with SSE streaming).
//! https://openrouter.ai/docs/api-reference/overview
//!
//! The API key is read from the OS credential store inside the backend and is
//! never passed to the webview or logged.

use super::{EventSink, Outcome, ProviderContext, ProviderEvent, ProviderRequest};
use crate::secrets;
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const APP_TITLE: &str = "Noli Desktop Companion";
const APP_URL: &str = "https://github.com/phantom-companion/phantom";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context_length: Option<u64>,
    /// USD per million prompt / completion tokens.
    pub prompt_price: Option<f64>,
    pub completion_price: Option<f64>,
    pub description: Option<String>,
    /// Accepts image input (can look at screenshots).
    #[serde(default)]
    pub vision: bool,
}

fn api_key() -> Result<String> {
    secrets::get(secrets::OPENROUTER_KEY)?
        .ok_or_else(|| anyhow!("No OpenRouter API key configured. Add one in Settings → AI Provider."))
}

fn base(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

fn per_million(v: Option<&Value>) -> Option<f64> {
    let s = v?.as_str()?;
    s.parse::<f64>().ok().map(|p| p * 1_000_000.0)
}

pub fn parse_models(body: &Value) -> Vec<ModelInfo> {
    let mut out: Vec<ModelInfo> = body["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|m| {
                    // text output only
                    m["architecture"]["output_modalities"].as_array().map(|o| o.iter().any(|x| x == "text")).unwrap_or(true)
                })
                .filter_map(|m| {
                    Some(ModelInfo {
                        id: m["id"].as_str()?.to_string(),
                        name: m["name"].as_str().unwrap_or_default().to_string(),
                        context_length: m["context_length"].as_u64(),
                        prompt_price: per_million(m["pricing"].get("prompt")),
                        completion_price: per_million(m["pricing"].get("completion")),
                        description: m["description"].as_str().map(|d| d.chars().take(240).collect()),
                        vision: m["architecture"]["input_modalities"].as_array().is_some_and(|i| i.iter().any(|x| x == "image")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Returns only the free models (both prompt and completion price are zero).
pub fn free_models(models: Vec<ModelInfo>) -> Vec<ModelInfo> {
    models
        .into_iter()
        .filter(|m| m.prompt_price == Some(0.0) && m.completion_price == Some(0.0))
        .collect()
}

pub async fn list_models(ctx: &ProviderContext, base_url: &str) -> Result<Vec<ModelInfo>> {
    let resp = ctx.http.get(format!("{}/models", base(base_url))).send().await.context("could not reach OpenRouter")?;
    if !resp.status().is_success() {
        return Err(anyhow!("OpenRouter returned {} while listing models", resp.status()));
    }
    let body: Value = resp.json().await?;
    Ok(free_models(parse_models(&body)))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    pub ok: bool,
    pub label: Option<String>,
    pub usage: Option<f64>,
    pub limit: Option<f64>,
    pub is_free_tier: Option<bool>,
    pub message: String,
}

/// Validates a key (the stored one if `candidate` is None) via GET /key.
pub async fn test_key(ctx: &ProviderContext, base_url: &str, candidate: Option<&str>) -> Result<KeyCheck> {
    let key = match candidate {
        Some(k) if !k.trim().is_empty() => k.trim().to_string(),
        _ => api_key()?,
    };
    let resp = ctx.http.get(format!("{}/key", base(base_url))).bearer_auth(&key).send().await.context("could not reach OpenRouter — check your internet connection")?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Ok(KeyCheck { ok: false, label: None, usage: None, limit: None, is_free_tier: None, message: "OpenRouter rejected this API key.".into() });
    }
    if !status.is_success() {
        return Ok(KeyCheck { ok: false, label: None, usage: None, limit: None, is_free_tier: None, message: error_message(status.as_u16(), &body) });
    }
    let d = &body["data"];
    Ok(KeyCheck {
        ok: true,
        label: d["label"].as_str().map(|s| s.to_string()),
        usage: d["usage"].as_f64(),
        limit: d["limit"].as_f64(),
        is_free_tier: d["is_free_tier"].as_bool(),
        message: "Connected to OpenRouter.".into(),
    })
}

/// Free, image-capable models tried in order when a free model is unavailable.
const FREE_FALLBACKS: [&str; 3] = ["inclusionai/ling-3.2-flash:free", "google/gemma-4-31b-it:free", "nvidia/nemotron-3.5-super-vl:free"];

/// Up to two backup models for a free model (none for paid ones).
pub fn free_fallbacks(model: &str) -> Vec<&'static str> {
    if !model.ends_with(":free") {
        return vec![];
    }
    FREE_FALLBACKS.into_iter().filter(|m| *m != model).take(2).collect()
}

pub fn error_message(status: u16, body: &Value) -> String {
    let detail = body["error"]["message"].as_str().map(|s| s.to_string()).unwrap_or_default();
    let meta = &body["error"]["metadata"];
    if status == 429 {
        // Two very different 429s: the account's daily free quota, or the free
        // model's upstream host being overloaded for everyone.
        if detail.contains("free-models-per-day") {
            return "OpenRouter free-models-per-day limit: this account has used today's free requests (50 a day until $10 of credit has been bought, then 1000). It resets at midnight UTC.".into();
        }
        if let Some(provider) = meta["provider_name"].as_str().filter(|p| !p.is_empty()) {
            let raw = meta["raw"].as_str().unwrap_or_default();
            let raw: String = raw.chars().take(160).collect();
            return format!("Free model busy upstream: {provider} is rate-limiting this free model for everyone on OpenRouter (not your key). Try again shortly or pick another model.{}", if raw.is_empty() { String::new() } else { format!(" ({raw})") });
        }
    }
    let base = match status {
        400 => "OpenRouter rejected the request",
        401 => "OpenRouter rejected the API key",
        402 => "Your OpenRouter account is out of credits",
        403 => "This request was blocked by OpenRouter moderation",
        404 => "That model was not found on OpenRouter",
        408 => "OpenRouter timed out",
        429 => "OpenRouter rate limit reached — wait a moment and retry",
        502 | 503 => "The model provider is unavailable right now",
        _ => "OpenRouter error",
    };
    if detail.is_empty() {
        format!("{base} (HTTP {status}).")
    } else {
        format!("{base}: {detail}")
    }
}

/// Incremental SSE parser for OpenAI-style streams.
#[derive(Default)]
pub struct SseParser {
    buf: String,
}

#[derive(Debug, PartialEq)]
pub enum SseItem {
    Data(String),
    Done,
}

impl SseParser {
    pub fn push(&mut self, chunk: &str) -> Vec<SseItem> {
        self.buf.push_str(chunk);
        let mut items = vec![];
        while let Some(pos) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=pos).collect();
            let line = line.trim_end_matches(['\r', '\n']);
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim_start();
                if data == "[DONE]" {
                    items.push(SseItem::Done);
                } else if !data.is_empty() {
                    items.push(SseItem::Data(data.to_string()));
                }
            }
            // comments (": OPENROUTER PROCESSING"), event:, id: lines are ignored
        }
        items
    }
}

pub fn build_messages(req: &ProviderRequest) -> Vec<Value> {
    let mut messages = vec![json!({ "role": "system", "content": req.system_prompt })];
    for t in &req.history {
        messages.push(json!({ "role": t.role, "content": t.content }));
    }
    messages.push(json!({ "role": "user", "content": super::user_content(&req.user_message, &req.user_images) }));
    messages
}

pub async fn run(ctx: &ProviderContext, req: ProviderRequest, sink: EventSink, cancel: CancellationToken) -> Result<Outcome> {
    let cfg = req.settings.provider.openrouter.clone();
    let key = api_key()?;
    let model = cfg.model.trim().to_string();
    if model.is_empty() {
        return Err(anyhow!("Choose an OpenRouter model in Settings → AI Provider."));
    }
    let mut body = json!({
        "model": model,
        "messages": build_messages(&req),
        "stream": true,
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
    });
    // Free models are often overloaded upstream; let OpenRouter fall back to
    // other free models that can also see images.
    let fallbacks = free_fallbacks(&model);
    if !fallbacks.is_empty() {
        let mut all = vec![model.clone()];
        all.extend(fallbacks.into_iter().map(String::from));
        body["models"] = json!(all);
    }
    let send = ctx
        .http
        .post(format!("{}/chat/completions", base(&cfg.base_url)))
        .bearer_auth(&key)
        .header("HTTP-Referer", APP_URL)
        .header("X-Title", APP_TITLE)
        .json(&body)
        .send();
    let resp = tokio::select! {
        r = send => r.context("could not reach OpenRouter — check your internet connection")?,
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
        let chunk = chunk.context("connection to OpenRouter dropped")?;
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
                        // same wording as HTTP errors (stream errors carry a numeric code)
                        let code = err["code"].as_u64().and_then(|c| u16::try_from(c).ok()).unwrap_or(500);
                        return Err(anyhow!(error_message(code, &json!({ "error": err }))));
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
    fn sse_parser_handles_split_chunks_and_comments() {
        let mut p = SseParser::default();
        assert!(p.push(": OPENROUTER PROCESSING\n\n").is_empty());
        assert!(p.push("data: {\"a\":").is_empty());
        let items = p.push("1}\n\ndata: [DONE]\n");
        assert_eq!(items, vec![SseItem::Data("{\"a\":1}".into()), SseItem::Done]);
    }

    #[test]
    fn parses_models() {
        let body = json!({"data": [
            {"id": "b/model", "name": "B", "context_length": 1000, "pricing": {"prompt": "0.000003", "completion": "0.000015"}, "architecture": {"output_modalities": ["text"]}},
            {"id": "img/only", "name": "Img", "architecture": {"output_modalities": ["image"]}},
            {"id": "a/model", "name": "A"}
        ]});
        let m = parse_models(&body);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].id, "a/model");
        assert!((m[1].prompt_price.unwrap() - 3.0).abs() < 1e-9);
    }

    #[test]
    fn free_models_get_fallbacks() {
        assert_eq!(free_fallbacks("google/gemma-4-31b-it:free"), ["inclusionai/ling-3.2-flash:free", "nvidia/nemotron-3.5-super-vl:free"]);
        assert_eq!(free_fallbacks("x/other:free").len(), 2);
        assert!(free_fallbacks("anthropic/claude-haiku-5.5").is_empty());
    }

    #[test]
    fn rate_limits_are_told_apart() {
        let daily = json!({"error": {"message": "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"}});
        assert!(error_message(429, &daily).contains("free-models-per-day"));
        let upstream = json!({"error": {"message": "Provider returned error", "metadata": {"provider_name": "Google AI Studio", "raw": "google/gemma-4-31b-it:free is temporarily rate-limited upstream."}}});
        let m = error_message(429, &upstream);
        assert!(m.contains("busy upstream") && m.contains("Google AI Studio") && m.contains("not your key"), "{m}");
        assert!(error_message(429, &json!({"error": {"message": "slow down"}})).contains("rate limit"));
    }

    #[test]
    fn error_messages_are_friendly() {
        assert!(error_message(402, &Value::Null).contains("out of credits"));
        let b = json!({"error": {"message": "No endpoints found"}});
        assert_eq!(error_message(404, &b), "That model was not found on OpenRouter: No endpoints found");
    }

    #[test]
    fn builds_messages_with_system_and_history() {
        let req = ProviderRequest {
            conversation_id: "c".into(),
            system_prompt: "sys".into(),
            history: vec![super::super::ChatTurn { role: "assistant".into(), content: "hi".into() }],
            user_message: "yo".into(),
            resume_session: None,
            user_images: vec![],
            settings: Default::default(),
        };
        let m = build_messages(&req);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[2]["content"], "yo");
    }
}
