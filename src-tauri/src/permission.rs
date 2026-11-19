//! Permission bridge for the Claude Code agent.
//!
//! PHANTOM runs a tiny MCP server (streamable HTTP, JSON responses) bound to
//! 127.0.0.1 with a random bearer token. Claude Code is started with
//! `--permission-prompt-tool mcp__phantom__approve`, so every action that is
//! not already allowed calls this tool. We show an approval dialog in the chat
//! window and block until the user answers (or deny after a timeout).

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug)]
pub struct BridgeInfo {
    pub url: String,
    pub token: String,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub conversation_id: String,
    pub workspace: String,
    pub tool_name: String,
    pub summary: Option<String>,
    pub input: Value,
}

pub struct Decision {
    pub allow: bool,
}

pub struct PermissionBridge {
    pub info: BridgeInfo,
    pending: Mutex<HashMap<String, (PermissionRequest, SyncSender<Decision>)>>,
    /// Rules the user chose to "always allow" for this run of the app.
    remembered: Mutex<HashSet<String>>,
}

const TIMEOUT: Duration = Duration::from_secs(600);

pub fn remember_key(tool: &str, input: &Value) -> String {
    match tool {
        "Bash" | "run_command" => format!("{tool}:{}", input["command"].as_str().unwrap_or_default()),
        _ => tool.to_string(),
    }
}

impl PermissionBridge {
    /// Starts the server on an ephemeral local port.
    pub fn start(app: AppHandle) -> anyhow::Result<Arc<Self>> {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| anyhow::anyhow!("permission bridge: {e}"))?;
        let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let bridge = Arc::new(Self {
            info: BridgeInfo { url: format!("http://127.0.0.1:{port}/mcp"), token },
            pending: Mutex::new(HashMap::new()),
            remembered: Mutex::new(HashSet::new()),
        });
        let b = bridge.clone();
        std::thread::Builder::new().name("phantom-permission-bridge".into()).spawn(move || {
            for req in server.incoming_requests() {
                let b = b.clone();
                let app = app.clone();
                std::thread::spawn(move || b.handle(app, req));
            }
        })?;
        Ok(bridge)
    }

    pub fn pending(&self) -> Vec<PermissionRequest> {
        self.pending.lock().values().map(|(r, _)| r.clone()).collect()
    }

    pub fn respond(&self, id: &str, allow: bool, remember: bool) -> bool {
        if let Some((req, tx)) = self.pending.lock().remove(id) {
            if allow && remember {
                self.remembered.lock().insert(remember_key(&req.tool_name, &req.input));
            }
            let _ = tx.send(Decision { allow });
            true
        } else {
            false
        }
    }

    /// Denies everything waiting for a conversation (e.g. when it is cancelled).
    pub fn deny_conversation(&self, conversation_id: &str) {
        let ids: Vec<String> = self.pending.lock().iter().filter(|(_, (r, _))| r.conversation_id == conversation_id).map(|(k, _)| k.clone()).collect();
        for id in ids {
            self.respond(&id, false, false);
        }
    }

    fn handle(&self, app: AppHandle, mut req: tiny_http::Request) {
        let authorized = req
            .headers()
            .iter()
            .any(|h| h.field.equiv("Authorization") && h.value.as_str() == format!("Bearer {}", self.info.token));
        let url = req.url().to_string();
        if !url.starts_with("/mcp") || !authorized {
            let _ = req.respond(tiny_http::Response::empty(401));
            return;
        }
        if *req.method() != tiny_http::Method::Post {
            // No server-initiated stream is offered.
            let _ = req.respond(tiny_http::Response::empty(405));
            return;
        }
        let mut body = String::new();
        if req.as_reader().take(4 * 1024 * 1024).read_to_string(&mut body).is_err() {
            let _ = req.respond(tiny_http::Response::empty(400));
            return;
        }
        let query = parse_query(&url);
        let Ok(msg) = serde_json::from_str::<Value>(&body) else {
            let _ = req.respond(tiny_http::Response::empty(400));
            return;
        };
        match self.dispatch(&app, &msg, &query) {
            Some(resp) => {
                let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
                let _ = req.respond(tiny_http::Response::from_string(resp.to_string()).with_header(header));
            }
            None => {
                let _ = req.respond(tiny_http::Response::empty(202));
            }
        }
    }

    /// Handles one JSON-RPC message; `None` for notifications.
    pub fn dispatch(&self, app: &AppHandle, msg: &Value, query: &HashMap<String, String>) -> Option<Value> {
        let id = msg.get("id")?.clone();
        let method = msg["method"].as_str().unwrap_or_default();
        let result = match method {
            "initialize" => json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "phantom", "version": env!("CARGO_PKG_VERSION") }
            }),
            "ping" => json!({}),
            "tools/list" => json!({ "tools": [{
                "name": "approve",
                "description": "Ask the PHANTOM user whether the agent may use a tool.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tool_name": { "type": "string" },
                        "input": { "type": "object" },
                        "tool_use_id": { "type": "string" }
                    },
                    "required": ["tool_name", "input"]
                }
            }]}),
            "tools/call" => {
                let args = &msg["params"]["arguments"];
                let decision = self.ask(app, args, query);
                json!({ "content": [{ "type": "text", "text": decision.to_string() }] })
            }
            _ => {
                return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } }));
            }
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    fn ask(&self, app: &AppHandle, args: &Value, query: &HashMap<String, String>) -> Value {
        let tool = args["tool_name"].as_str().unwrap_or("unknown").to_string();
        let input = args["input"].clone();
        let summary = crate::providers::claude_code::summarize_tool(&tool, &input);
        let conv = query.get("conv").cloned().unwrap_or_default();
        let ws = query.get("ws").cloned().unwrap_or_default();
        match self.request(app, &conv, &ws, &tool, input.clone(), summary) {
            Some(true) => json!({ "behavior": "allow", "updatedInput": input }),
            Some(false) => json!({ "behavior": "deny", "message": format!("The user denied permission to use {tool}.") }),
            None => json!({ "behavior": "deny", "message": "No answer from the user in time; permission denied." }),
        }
    }

    /// Asks the user (blocking) whether `tool` may run. `None` = timed out.
    /// Remembered "always allow" answers return immediately.
    pub fn request(&self, app: &AppHandle, conversation_id: &str, workspace: &str, tool: &str, input: Value, summary: Option<String>) -> Option<bool> {
        if self.remembered.lock().contains(&remember_key(tool, &input)) {
            return Some(true);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let request = PermissionRequest {
            id: id.clone(),
            conversation_id: conversation_id.to_string(),
            workspace: workspace.to_string(),
            summary,
            tool_name: tool.to_string(),
            input,
        };
        let (tx, rx) = sync_channel(1);
        self.pending.lock().insert(id.clone(), (request.clone(), tx));
        let _ = app.emit("permission://request", request);
        crate::windows::open_chatbox(app, false);
        let decision = rx.recv_timeout(TIMEOUT);
        self.pending.lock().remove(&id);
        let _ = app.emit("permission://resolved", &id);
        decision.ok().map(|d| d.allow)
    }
}

fn parse_query(url: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some((_, q)) = url.split_once('?') {
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                out.insert(k.to_string(), pct_decode(v));
            }
        }
    }
    out
}

fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_decoding() {
        let q = parse_query("/mcp?conv=c%201&ws=%2FUsers%2Fme%2Fproj");
        assert_eq!(q["conv"], "c 1");
        assert_eq!(q["ws"], "/Users/me/proj");
    }

    #[test]
    fn remember_keys_are_command_specific_for_bash() {
        assert_eq!(remember_key("Bash", &json!({"command": "ls"})), "Bash:ls");
        assert_eq!(remember_key("Edit", &json!({"file_path": "/x"})), "Edit");
    }
}
