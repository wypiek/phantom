//! Claude Code provider.
//!
//! Drives the user's installed Claude Code CLI in non-interactive mode
//! (`claude -p --output-format stream-json`), reusing its existing login.
//! Conversation context is kept by resuming the agent's own session id.
//!
//! Safety: PHANTOM never passes `--dangerously-skip-permissions`. Whenever the
//! agent wants to do something that needs approval, Claude Code calls PHANTOM's
//! local MCP approval tool (see `permission.rs`), which asks the user.

use super::{transcript, Activity, EventSink, Outcome, ProviderContext, ProviderEvent, ProviderRequest};
use crate::settings::{ClaudePermission, Settings};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub logged_in: bool,
    pub auth_method: Option<String>,
    pub subscription: Option<String>,
    pub error: Option<String>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

/// Locates the `claude` executable: configured path → PATH (incl. login shell PATH) → common install locations.
pub fn find_claude(configured: &str, env_path: Option<&str>) -> Option<PathBuf> {
    if !configured.trim().is_empty() {
        let p = PathBuf::from(configured.trim());
        return p.exists().then_some(p);
    }
    if let Some(p) = crate::tts::find_exe("claude", env_path) {
        return Some(p);
    }
    let h = home();
    let mut candidates = vec![
        h.join(".local/bin/claude"),
        h.join(".claude/local/claude"),
        h.join(".npm-global/bin/claude"),
        h.join(".bun/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/usr/bin/claude"),
    ];
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            candidates.push(PathBuf::from(&appdata).join("npm/claude.cmd"));
        }
        candidates.push(h.join(".local/bin/claude.exe"));
    }
    candidates.into_iter().find(|p| p.exists())
}

fn base_command(bin: &PathBuf, env_path: Option<&str>) -> Command {
    let mut c = Command::new(bin);
    if let Some(p) = env_path {
        c.env("PATH", p);
    }
    // Don't let a parent Claude Code session (if PHANTOM was launched from one) leak in.
    c.env_remove("CLAUDECODE").env_remove("CLAUDE_CODE_ENTRYPOINT");
    #[cfg(windows)]
    {
        c.creation_flags(0x08000000);
    }
    c.kill_on_drop(true);
    c
}

pub async fn status(settings: &Settings, env_path: Option<&str>) -> ClaudeStatus {
    let Some(bin) = find_claude(&settings.provider.claude_code.binary_path, env_path) else {
        return ClaudeStatus { error: Some("Claude Code was not found. Install it from https://claude.com/claude-code, then reopen this screen.".into()), ..Default::default() };
    };
    let mut st = ClaudeStatus { installed: true, path: Some(bin.to_string_lossy().into_owned()), ..Default::default() };
    match base_command(&bin, env_path).arg("--version").output().await {
        Ok(o) => st.version = Some(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        Err(e) => {
            st.error = Some(format!("Found Claude Code but it would not run: {e}"));
            return st;
        }
    }
    let auth = tokio::time::timeout(std::time::Duration::from_secs(20), base_command(&bin, env_path).args(["auth", "status", "--json"]).output()).await;
    match auth {
        Ok(Ok(o)) => {
            let v: Value = serde_json::from_slice(&o.stdout).unwrap_or(Value::Null);
            st.logged_in = v["loggedIn"].as_bool().unwrap_or(false);
            st.auth_method = v["authMethod"].as_str().map(Into::into);
            st.subscription = v["subscriptionType"].as_str().map(Into::into);
            if !st.logged_in {
                st.error = Some("Claude Code is installed but not signed in. Run `claude` in a terminal and sign in, then retry.".into());
            }
        }
        Ok(Err(e)) => st.error = Some(format!("Could not check Claude Code sign-in: {e}")),
        Err(_) => st.error = Some("Checking Claude Code sign-in timed out.".into()),
    }
    st
}

/// Short human summary of a tool call's input.
pub fn summarize_tool(name: &str, input: &Value) -> Option<String> {
    let s = |k: &str| input.get(k).and_then(|v| v.as_str()).map(|v| v.to_string());
    let out = match name {
        "Bash" => s("command"),
        "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => s("file_path").or_else(|| s("notebook_path")),
        "Glob" | "Grep" => s("pattern"),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        "Task" | "Agent" => s("description"),
        "TodoWrite" => Some("updating task list".into()),
        _ => input.as_object().and_then(|o| o.values().find_map(|v| v.as_str().map(|x| x.to_string()))),
    }?;
    let out = out.replace('\n', " ");
    Some(if out.chars().count() > 160 { format!("{}…", out.chars().take(160).collect::<String>()) } else { out })
}

pub fn build_args(req: &ProviderRequest, ctx: &ProviderContext, workspace: &str) -> Vec<String> {
    let cc = &req.settings.provider.claude_code;
    let mut a: Vec<String> = vec!["-p".into(), "--output-format".into(), "stream-json".into(), "--verbose".into(), "--include-partial-messages".into()];
    a.push("--append-system-prompt".into());
    a.push(req.system_prompt.clone());
    if !cc.model.trim().is_empty() {
        a.push("--model".into());
        a.push(cc.model.trim().into());
    }
    if let Some(sid) = &req.resume_session {
        a.push("--resume".into());
        a.push(sid.clone());
    }
    let use_bridge = !matches!(cc.permission, ClaudePermission::ChatOnly);
    match cc.permission {
        ClaudePermission::ChatOnly => {
            a.push("--tools".into());
            a.push(String::new());
        }
        ClaudePermission::ReadOnly => {
            a.push("--permission-mode".into());
            a.push("plan".into());
        }
        ClaudePermission::Ask => {
            a.push("--permission-mode".into());
            a.push("default".into());
        }
        ClaudePermission::AcceptEdits => {
            a.push("--permission-mode".into());
            a.push("acceptEdits".into());
        }
    }
    if let (true, Some(bridge)) = (use_bridge, &ctx.permission_bridge) {
        let url = format!("{}?conv={}&ws={}", bridge.url, pct(&req.conversation_id), pct(workspace));
        let cfg = serde_json::json!({ "mcpServers": { "phantom": { "type": "http", "url": url, "headers": { "Authorization": format!("Bearer {}", bridge.token) } } } });
        a.push("--mcp-config".into());
        a.push(cfg.to_string());
        a.push("--permission-prompt-tool".into());
        a.push("mcp__phantom__approve".into());
    } else if use_bridge {
        // No approval channel → anything needing approval is denied, never auto-allowed.
        a.push("--permission-prompts".into());
        a.push("none".into());
    }
    if cc.lightweight {
        a.push("--strict-mcp-config".into());
    }
    let allowed: Vec<String> = cc.allowed_tools.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    if !allowed.is_empty() && use_bridge {
        a.push("--allowedTools".into());
        a.extend(allowed);
    }
    a
}

fn pct(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn build_prompt(req: &ProviderRequest) -> String {
    let mut user = req.user_message.clone();
    for (i, url) in req.user_images.iter().enumerate() {
        if let Some(b64) = url.split_once(",").map(|(_, b)| b) {
            let path = std::env::temp_dir().join(format!("noli-shot-{}-{i}.jpg", std::process::id()));
            if std::fs::write(&path, base64_decode(b64)).is_ok() {
                user.push_str(&format!("\n\n(Screenshot saved at {} — view it with the Read tool.)", path.display()));
            }
        }
    }
    let req = &ProviderRequest { user_message: user, ..req.clone() };
    if req.resume_session.is_none() && !req.history.is_empty() {
        format!(
            "<earlier_conversation>\n{}\n</earlier_conversation>\n\nThe conversation above happened before this session started (possibly with a different AI backend). Continue it naturally.\n\n{}",
            transcript(&req.history, 24_000),
            req.user_message
        )
    } else {
        req.user_message.clone()
    }
}

fn base64_decode(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes().filter_map(val) {
        acc = (acc << 6) | c as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

pub fn resolve_workspace(settings: &Settings, default: &std::path::Path) -> Result<PathBuf> {
    let configured = settings.provider.claude_code.working_directory.trim();
    let ws = if configured.is_empty() { default.to_path_buf() } else { PathBuf::from(configured) };
    std::fs::create_dir_all(&ws).ok();
    if !ws.is_dir() {
        return Err(anyhow!("The Claude Code working directory does not exist: {}", ws.display()));
    }
    Ok(ws)
}

/// State machine that turns stream-json lines into provider events.
#[derive(Default)]
pub struct StreamState {
    pub session_id: Option<String>,
    pub model: Option<String>,
    emitted_text: bool,
    current_msg: Option<String>,
    msg_has_delta: std::collections::HashSet<String>,
    msg_text_started: std::collections::HashSet<String>,
    tools: HashMap<String, Activity>,
    pub result: Option<std::result::Result<(), String>>,
}

impl StreamState {
    fn text(&mut self, msg_id: &str, text: &str, out: &mut Vec<ProviderEvent>) {
        if text.is_empty() {
            return;
        }
        if !self.msg_text_started.contains(msg_id) {
            if self.emitted_text {
                out.push(ProviderEvent::Delta("\n\n".into()));
            }
            self.msg_text_started.insert(msg_id.to_string());
        }
        self.emitted_text = true;
        out.push(ProviderEvent::Delta(text.to_string()));
    }

    pub fn handle(&mut self, v: &Value) -> Vec<ProviderEvent> {
        let mut out = vec![];
        // Ignore output of sub-agents; only the main agent speaks to the user.
        let nested = !v["parent_tool_use_id"].is_null() && v.get("parent_tool_use_id").is_some();
        match v["type"].as_str().unwrap_or_default() {
            "system" if v["subtype"] == "init" => {
                if let Some(s) = v["session_id"].as_str() {
                    self.session_id = Some(s.into());
                    out.push(ProviderEvent::SessionId(s.into()));
                }
                if let Some(m) = v["model"].as_str() {
                    self.model = Some(m.into());
                    out.push(ProviderEvent::Model(m.into()));
                }
            }
            "system" if v["subtype"] == "api_retry" => {
                out.push(ProviderEvent::Activity(Activity {
                    id: "retry".into(),
                    kind: "status".into(),
                    label: "Retrying the API…".into(),
                    detail: v["error"].as_str().map(Into::into),
                    state: "info".into(),
                }));
            }
            "stream_event" if !nested => {
                let ev = &v["event"];
                match ev["type"].as_str().unwrap_or_default() {
                    "message_start" => {
                        self.current_msg = ev["message"]["id"].as_str().map(Into::into);
                    }
                    "content_block_start" => {
                        let b = &ev["content_block"];
                        if b["type"] == "tool_use" {
                            let id = b["id"].as_str().unwrap_or_default().to_string();
                            let a = Activity { id: id.clone(), kind: "tool".into(), label: b["name"].as_str().unwrap_or("tool").into(), detail: None, state: "running".into() };
                            self.tools.insert(id, a.clone());
                            out.push(ProviderEvent::Activity(a));
                        }
                    }
                    "content_block_delta" => {
                        if ev["delta"]["type"] == "text_delta" {
                            let msg = self.current_msg.clone().unwrap_or_default();
                            self.msg_has_delta.insert(msg.clone());
                            let t = ev["delta"]["text"].as_str().unwrap_or_default().to_string();
                            self.text(&msg, &t, &mut out);
                        }
                    }
                    _ => {}
                }
            }
            "assistant" if !nested => {
                let msg = &v["message"];
                let msg_id = msg["id"].as_str().unwrap_or_default().to_string();
                if let Some(blocks) = msg["content"].as_array() {
                    for b in blocks {
                        match b["type"].as_str().unwrap_or_default() {
                            "text" if !self.msg_has_delta.contains(&msg_id) => {
                                let t = b["text"].as_str().unwrap_or_default().to_string();
                                self.text(&msg_id, &t, &mut out);
                            }
                            "tool_use" => {
                                let id = b["id"].as_str().unwrap_or_default().to_string();
                                let name = b["name"].as_str().unwrap_or("tool").to_string();
                                let a = self.tools.entry(id.clone()).or_insert(Activity { id, kind: "tool".into(), label: name.clone(), detail: None, state: "running".into() });
                                a.detail = summarize_tool(&name, &b["input"]);
                                out.push(ProviderEvent::Activity(a.clone()));
                            }
                            _ => {}
                        }
                    }
                }
            }
            "user" => {
                if let Some(blocks) = v["message"]["content"].as_array() {
                    for b in blocks {
                        if b["type"] == "tool_result" {
                            let id = b["tool_use_id"].as_str().unwrap_or_default();
                            if let Some(a) = self.tools.get_mut(id) {
                                a.state = if b["is_error"].as_bool().unwrap_or(false) { "error".into() } else { "done".into() };
                                out.push(ProviderEvent::Activity(a.clone()));
                            }
                        }
                    }
                }
            }
            "result" => {
                if let Some(s) = v["session_id"].as_str() {
                    self.session_id = Some(s.into());
                }
                if let Some(denials) = v["permission_denials"].as_array() {
                    for d in denials {
                        let name = d["tool_name"].as_str().unwrap_or("tool");
                        let id = d["tool_use_id"].as_str().unwrap_or_default().to_string();
                        out.push(ProviderEvent::Activity(Activity {
                            id: if id.is_empty() { format!("denied-{name}") } else { id },
                            kind: "tool".into(),
                            label: name.into(),
                            detail: summarize_tool(name, &d["tool_input"]),
                            state: "denied".into(),
                        }));
                    }
                }
                let is_error = v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str().map(|s| s.starts_with("error")).unwrap_or(false);
                if is_error {
                    let msg = v["result"].as_str().filter(|s| !s.is_empty()).map(Into::into).unwrap_or_else(|| {
                        match v["subtype"].as_str() {
                            Some("error_max_turns") => "Claude Code stopped: maximum number of turns reached.".to_string(),
                            Some(other) => format!("Claude Code reported an error ({other})."),
                            None => "Claude Code reported an error.".to_string(),
                        }
                    });
                    self.result = Some(Err(msg));
                } else {
                    if !self.emitted_text {
                        if let Some(t) = v["result"].as_str() {
                            self.text("result", t, &mut out);
                        }
                    }
                    self.result = Some(Ok(()));
                }
            }
            _ => {}
        }
        out
    }
}

pub async fn run(ctx: &ProviderContext, req: ProviderRequest, sink: EventSink, cancel: CancellationToken) -> Result<Outcome> {
    match run_once(ctx, &req, &sink, &cancel).await {
        Err(e) if req.resume_session.is_some() && format!("{e:#}").contains("No conversation found") => {
            // The agent's stored session is gone — start fresh, seeded with our transcript.
            let mut fresh = req.clone();
            fresh.resume_session = None;
            run_once(ctx, &fresh, &sink, &cancel).await
        }
        other => other,
    }
}

async fn run_once(ctx: &ProviderContext, req: &ProviderRequest, sink: &EventSink, cancel: &CancellationToken) -> Result<Outcome> {
    let cc = &req.settings.provider.claude_code;
    let bin = find_claude(&cc.binary_path, ctx.env_path.as_deref())
        .ok_or_else(|| anyhow!("Claude Code is not installed (or not found). Set its path in Settings → AI Provider."))?;
    let workspace = resolve_workspace(&req.settings, &ctx.default_workspace)?;
    let ws = workspace.to_string_lossy().into_owned();
    let args = build_args(req, ctx, &ws);
    let _ = sink.send(ProviderEvent::Activity(Activity {
        id: "workspace".into(),
        kind: "status".into(),
        label: "Workspace".into(),
        detail: Some(ws.clone()),
        state: "info".into(),
    }));

    let mut child = base_command(&bin, ctx.env_path.as_deref())
        .args(&args)
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not start Claude Code")?;
    {
        let mut stdin = child.stdin.take().context("no stdin")?;
        stdin.write_all(build_prompt(req).as_bytes()).await?;
        stdin.shutdown().await?;
    }
    let stdout = child.stdout.take().context("no stdout")?;
    let mut stderr = child.stderr.take().context("no stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut state = StreamState::default();
    loop {
        let line = tokio::select! {
            l = lines.next_line() => l?,
            _ = cancel.cancelled() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Ok(Outcome { model: state.model, session_id: state.session_id });
            }
        };
        let Some(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        for ev in state.handle(&v) {
            let _ = sink.send(ev);
        }
    }
    let status = child.wait().await?;
    let stderr_text = stderr_task.await.unwrap_or_default();
    match state.result.take() {
        Some(Ok(())) => Ok(Outcome { model: state.model, session_id: state.session_id }),
        Some(Err(msg)) => Err(anyhow!(msg)),
        None => {
            let tail: String = stderr_text.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            if status.success() {
                Ok(Outcome { model: state.model, session_id: state.session_id })
            } else {
                Err(anyhow!("Claude Code exited unexpectedly ({status}). {}", if tail.is_empty() { "No error output.".into() } else { tail }))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn deltas(evs: &[ProviderEvent]) -> String {
        evs.iter().filter_map(|e| if let ProviderEvent::Delta(d) = e { Some(d.as_str()) } else { None }).collect()
    }

    #[test]
    fn parses_stream_with_tools() {
        let mut st = StreamState::default();
        let mut all = vec![];
        let lines = vec![
            json!({"type":"system","subtype":"init","session_id":"S1","model":"claude-x"}),
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}},"parent_tool_use_id":null}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Looking"}},"parent_tool_use_id":null}),
            json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"Bash"}},"parent_tool_use_id":null}),
            json!({"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Looking"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la"}}]},"parent_tool_use_id":null}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false}]}}),
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m2"}},"parent_tool_use_id":null}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Found it."}},"parent_tool_use_id":null}),
            json!({"type":"result","subtype":"success","is_error":false,"result":"Found it.","session_id":"S1"}),
        ];
        for l in &lines {
            all.extend(st.handle(l));
        }
        assert_eq!(deltas(&all), "Looking\n\nFound it.");
        assert_eq!(st.session_id.as_deref(), Some("S1"));
        assert_eq!(st.result, Some(Ok(())));
        let done = all.iter().filter_map(|e| if let ProviderEvent::Activity(a) = e { Some(a) } else { None }).last().unwrap();
        assert_eq!(done.state, "done");
        assert_eq!(done.detail.as_deref(), Some("ls -la"));
    }

    #[test]
    fn falls_back_to_full_messages_without_partials() {
        let mut st = StreamState::default();
        let evs = st.handle(&json!({"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hello."}]},"parent_tool_use_id":null}));
        assert_eq!(deltas(&evs), "Hello.");
        let evs = st.handle(&json!({"type":"result","subtype":"success","is_error":false,"result":"Hello."}));
        assert_eq!(deltas(&evs), "");
    }

    #[test]
    fn reports_errors_and_denials() {
        let mut st = StreamState::default();
        let evs = st.handle(&json!({"type":"result","subtype":"error_during_execution","is_error":true,"permission_denials":[{"tool_name":"Write","tool_use_id":"x","tool_input":{"file_path":"/etc/hosts"}}]}));
        assert!(matches!(&evs[0], ProviderEvent::Activity(a) if a.state == "denied" && a.detail.as_deref() == Some("/etc/hosts")));
        assert!(matches!(st.result, Some(Err(_))));
    }

    #[test]
    fn ignores_subagent_text() {
        let mut st = StreamState::default();
        let evs = st.handle(&json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"inner"}},"parent_tool_use_id":"t9"}));
        assert!(evs.is_empty());
    }

    #[test]
    fn args_never_skip_permissions() {
        let mut s = Settings::default();
        let ctx = ProviderContext { http: reqwest::Client::new(), env_path: None, default_workspace: "/tmp".into(), permission_bridge: Some(crate::permission::BridgeInfo { url: "http://127.0.0.1:1/mcp".into(), token: "tok".into() }) };
        for p in [ClaudePermission::ChatOnly, ClaudePermission::ReadOnly, ClaudePermission::Ask, ClaudePermission::AcceptEdits] {
            s.provider.claude_code.permission = p;
            let req = ProviderRequest { conversation_id: "c 1".into(), system_prompt: "sys".into(), history: vec![], user_message: "hi".into(), resume_session: Some("S".into()), user_images: vec![], settings: s.clone() };
            let a = build_args(&req, &ctx, "/w s");
            assert!(!a.iter().any(|x| x.contains("dangerously") || x == "bypassPermissions"));
            assert!(a.windows(2).any(|w| w[0] == "--resume" && w[1] == "S"));
            if p != ClaudePermission::ChatOnly {
                assert!(a.iter().any(|x| x == "mcp__phantom__approve"));
                assert!(a.iter().any(|x| x.contains("conv=c%201") && x.contains("ws=%2Fw%20s")));
            } else {
                assert!(a.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()));
            }
        }
    }

    #[test]
    fn prompt_seeds_transcript_only_without_session() {
        let mut req = ProviderRequest { conversation_id: "c".into(), system_prompt: "s".into(), history: vec![super::super::ChatTurn { role: "user".into(), content: "earlier".into() }], user_message: "now".into(), resume_session: None, user_images: vec![], settings: Settings::default() };
        assert!(build_prompt(&req).contains("earlier"));
        req.resume_session = Some("S".into());
        assert_eq!(build_prompt(&req), "now");
    }
}

/// Live round-trip against the installed Claude Code CLI.
/// Run with: cargo test live_ -- --ignored --nocapture
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn live_claude_code_streams_and_resumes() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings::default();
        s.provider.claude_code.permission = ClaudePermission::ChatOnly;
        s.provider.claude_code.working_directory = dir.path().to_string_lossy().into_owned();
        let ctx = ProviderContext { http: reqwest::Client::new(), env_path: crate::state::login_shell_path(), default_workspace: dir.path().into(), permission_bridge: None };
        let mk = |msg: &str, resume: Option<String>| ProviderRequest { conversation_id: "live".into(), system_prompt: "You are PHANTOM. Answer in at most 8 words.".into(), history: vec![], user_message: msg.into(), resume_session: resume, user_images: vec![], settings: s.clone() };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let out = run(&ctx, mk("My secret word is OBSIDIAN. Acknowledge briefly.", None), tx, CancellationToken::new()).await.unwrap();
        let mut deltas = 0;
        while let Ok(ev) = rx.try_recv() {
            if matches!(ev, ProviderEvent::Delta(_)) { deltas += 1; }
        }
        assert!(deltas > 0, "no streamed text");
        let sid = out.session_id.expect("session id");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        run(&ctx, mk("What was my secret word? One word.", Some(sid)), tx, CancellationToken::new()).await.unwrap();
        let mut text = String::new();
        while let Ok(ev) = rx.try_recv() {
            if let ProviderEvent::Delta(d) = ev { text.push_str(&d); }
        }
        println!("resumed answer: {text}");
        assert!(text.to_uppercase().contains("OBSIDIAN"));
    }
}
