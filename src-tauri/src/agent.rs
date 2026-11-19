//! Noli's computer-control agent.
//!
//! Models request actions with tags such as `<action name="click" x="10" y="20" />`.
//! The chat loop hides those tags from the stream ([`TagFilter`]), runs the
//! actions ([`execute`]) — asking the user first where required — and feeds the
//! results (including a screenshot the model can see) back for another step.

use crate::settings::{ControlMode, Settings};
use crate::system_tools::{self as sys, InputAction, ScreenGeometry};
use serde_json::json;
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActionCall {
    pub name: String,
    pub attrs: HashMap<String, String>,
    pub payload: String,
}

impl ActionCall {
    fn num(&self, k: &str) -> Option<f64> {
        self.attrs.get(k).and_then(|v| v.trim().parse::<f64>().ok())
    }
    fn flag(&self, k: &str) -> bool {
        matches!(self.attrs.get(k).map(|s| s.to_lowercase()).as_deref(), Some("true" | "1" | "yes"))
    }
}

/// Removes `<action>` and `<remember>` tags from streamed text as it arrives.
#[derive(Default)]
pub struct TagFilter {
    pending: String,
}

const TAGS: [(&str, &str); 3] = [("<action", "</action>"), ("<remember>", "</remember>"), ("<tool_call>", "</tool_call>")];
/// Closing tags some models emit on their own; never shown.
const STRAY: [&str; 3] = ["</tool_call>", "</action>", "</remember>"];

impl TagFilter {
    /// Feed a chunk; returns the text safe to show/speak now.
    pub fn push(&mut self, chunk: &str) -> String {
        self.pending.push_str(chunk);
        let mut out = String::new();
        loop {
            let Some(lt) = self.pending.find('<') else {
                out.push_str(&self.pending);
                self.pending.clear();
                break;
            };
            out.push_str(&self.pending[..lt]);
            self.pending.drain(..lt);
            let p = self.pending.as_str();
            if let Some(stray) = STRAY.iter().find(|t| p.starts_with(**t)) {
                self.pending.drain(..stray.len());
                continue;
            }
            // Could this still become one of our tags?
            let mut matched = None;
            let mut maybe = STRAY.iter().any(|t| t.starts_with(p));
            for (open, close) in TAGS {
                if p.starts_with(open) {
                    matched = Some((open, close));
                    break;
                }
                if open.starts_with(p) {
                    maybe = true;
                }
            }
            match matched {
                Some((open, close)) => {
                    // self-closing <action … />
                    if open == "<action" {
                        if let Some(gt) = p.find('>') {
                            if p[..gt].trim_end().ends_with('/') {
                                self.pending.drain(..=gt);
                                continue;
                            }
                        }
                    }
                    if let Some(end) = p.find(close) {
                        self.pending.drain(..end + close.len());
                        continue;
                    }
                    break; // wait for the rest of the tag
                }
                None if maybe => break, // e.g. "<act" — wait for more
                None => {
                    out.push('<');
                    self.pending.drain(..1);
                }
            }
        }
        out
    }

    /// End of stream: anything left is not a complete tag; drop unfinished tags.
    pub fn finish(&mut self) -> String {
        let p = std::mem::take(&mut self.pending);
        if TAGS.iter().any(|(o, _)| p.starts_with(o) || o.starts_with(p.as_str())) || STRAY.iter().any(|t| t.starts_with(p.as_str())) {
            String::new()
        } else {
            p
        }
    }
}

fn parse_attrs(header: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = header;
    while let Some(eq) = rest.find('=') {
        let key = rest[..eq].split_whitespace().last().unwrap_or("").trim().to_string();
        let after = rest[eq + 1..].trim_start();
        let (val, next) = if let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') {
            let body = &after[1..];
            match body.find(q) {
                Some(e) => (body[..e].to_string(), &body[e + 1..]),
                None => (body.to_string(), ""),
            }
        } else {
            let e = after.find(|c: char| c.is_whitespace() || c == '/' || c == '>').unwrap_or(after.len());
            (after[..e].to_string(), &after[e..])
        };
        if !key.is_empty() {
            out.insert(key.to_lowercase(), val);
        }
        rest = next;
    }
    out
}

/// Extracts actions and memories; returns (visible text, memories, actions).
pub fn parse_reply(text: &str) -> (String, Vec<String>, Vec<ActionCall>) {
    let mut clean = String::new();
    let mut mems = vec![];
    let mut actions = vec![];
    let mut rest = text;
    loop {
        let next = [rest.find("<action"), rest.find("<remember>"), rest.find("<tool_call>")].into_iter().flatten().min();
        let Some(pos) = next else {
            clean.push_str(rest);
            break;
        };
        clean.push_str(&rest[..pos]);
        let after = &rest[pos..];
        if let Some(body) = after.strip_prefix("<tool_call>") {
            // OpenAI/Qwen-style: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
            match body.find("</tool_call>") {
                Some(e) => {
                    if let Some(a) = tool_call_json(&body[..e]) {
                        actions.push(a);
                    }
                    rest = &body[e + "</tool_call>".len()..];
                }
                None => break,
            }
        } else if after.starts_with("<remember>") {
            let body = &after["<remember>".len()..];
            match body.find("</remember>") {
                Some(e) => {
                    let mtxt = body[..e].trim();
                    if !mtxt.is_empty() && mtxt.len() < 500 {
                        mems.push(mtxt.to_string());
                    }
                    rest = &body[e + "</remember>".len()..];
                }
                None => break,
            }
        } else {
            let Some(gt) = after.find('>') else { break };
            let header = &after["<action".len()..gt];
            let self_closing = header.trim_end().ends_with('/');
            let attrs = parse_attrs(header.trim_end().trim_end_matches('/'));
            let name = attrs.get("name").cloned().unwrap_or_default();
            if self_closing {
                actions.push(ActionCall { name, attrs, payload: String::new() });
                rest = &after[gt + 1..];
            } else {
                let body = &after[gt + 1..];
                match body.find("</action>") {
                    Some(e) => {
                        actions.push(ActionCall { name, attrs, payload: body[..e].trim().to_string() });
                        rest = &body[e + "</action>".len()..];
                    }
                    None => break,
                }
            }
        }
    }
    let mut clean = clean;
    for t in STRAY {
        clean = clean.replace(t, "");
    }
    (clean.trim().to_string(), mems, actions)
}

/// Converts a JSON tool call into an action. Text-like arguments become the payload.
fn tool_call_json(body: &str) -> Option<ActionCall> {
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    let name = v["name"].as_str()?.to_string();
    let args = match &v["arguments"] {
        serde_json::Value::String(s) => serde_json::from_str(s).unwrap_or(serde_json::Value::Null),
        other => other.clone(),
    };
    let mut attrs = HashMap::new();
    let mut payload = String::new();
    if let Some(obj) = args.as_object() {
        for (k, val) in obj {
            let text = val.as_str().map(str::to_string).unwrap_or_else(|| val.to_string());
            if payload.is_empty() && ["text", "command", "app", "name", "url", "keys", "key", "payload"].contains(&k.as_str()) {
                payload = text;
            } else {
                attrs.insert(k.to_lowercase(), text);
            }
        }
    }
    attrs.insert("name".into(), name.clone());
    Some(ActionCall { name, attrs, payload })
}

/// Instructions appended to the system prompt.
pub fn tool_prompt(settings: &Settings) -> String {
    if settings.computer.mode == ControlMode::Off {
        return "\n\nComputer access is turned off (Settings → Computer). You cannot see the screen, open apps or use the mouse; if asked, say so in one sentence.".into();
    }
    "\n\nYou can use the user's computer by writing action tags. Tags are hidden from the user and executed for you:
<action name=\"see_screen\" /> take a screenshot (you receive the image plus the front app and open apps)
<action name=\"open_app\">Safari</action>
<action name=\"open_url\">https://example.com</action>
<action name=\"click\" x=\"640\" y=\"400\" /> optional button=\"right\" or double=\"true\"; x/y are pixels in the latest screenshot
<action name=\"move_mouse\" x=\"640\" y=\"400\" />
<action name=\"scroll\" amount=\"5\" /> positive scrolls down; optional x/y
<action name=\"type\">text to type</action>
<action name=\"key\">cmd+t</action> e.g. cmd+c, enter, tab, esc, cmd+space
<action name=\"run_command\">shell command</action> macOS zsh; the user approves every command
<action name=\"wait\" ms=\"800\" />
Rules:
- Only act when the user asks you to do something on their computer or asks about their screen. Otherwise just talk.
- Write one short sentence saying what you'll do, then the tags. Never invent results: wait for the tool results, which arrive in the next message.
- Take a screenshot before clicking. After mouse/keyboard actions you automatically get a fresh screenshot.
- When the task is done (or impossible), give a brief final answer without tags.
- If asked whether you can see the screen: yes — use see_screen and describe what you see.".into()
}

pub struct StepResult {
    pub text: String,
    pub image_data_url: Option<String>,
}

/// Needs approval in the current mode? Screenshots never ask while control is on.
fn needs_approval(mode: ControlMode, name: &str) -> bool {
    match name {
        "see_screen" | "wait" => false,
        "run_command" => true,
        _ => mode == ControlMode::Ask,
    }
}

fn describe(a: &ActionCall) -> String {
    let xy = || format!("({}, {})", a.attrs.get("x").map(String::as_str).unwrap_or("?"), a.attrs.get("y").map(String::as_str).unwrap_or("?"));
    match a.name.as_str() {
        "see_screen" => "look at the screen".into(),
        "open_app" => format!("open {}", a.payload),
        "open_url" => format!("open {}", a.payload),
        "click" => format!("{}click at {}", if a.flag("double") { "double-" } else if a.attrs.get("button").map(|b| b == "right").unwrap_or(false) { "right-" } else { "" }, xy()),
        "move_mouse" => format!("move the mouse to {}", xy()),
        "scroll" => format!("scroll {}", a.attrs.get("amount").cloned().unwrap_or_default()),
        "type" => format!("type “{}”", a.payload.chars().take(80).collect::<String>()),
        "key" => format!("press {}", a.payload),
        "run_command" => a.payload.clone(),
        "wait" => "wait".into(),
        other => other.to_string(),
    }
}

fn label(a: &ActionCall) -> String {
    match a.name.as_str() {
        "see_screen" => "Screen".into(),
        "open_app" | "open_url" => "Open".into(),
        "click" | "move_mouse" | "scroll" => "Mouse".into(),
        "type" | "key" => "Keyboard".into(),
        "run_command" => "Command".into(),
        other => other.to_string(),
    }
}

pub fn activity_label(a: &ActionCall) -> (String, String) {
    (label(a), describe(a))
}

fn primary_display(app: &AppHandle) -> (f64, f64, f64, f64) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let s = m.scale_factor();
        let size = m.size().to_logical::<f64>(s);
        let pos = m.position().to_logical::<f64>(s);
        return (size.width, size.height, pos.x, pos.y);
    }
    (1440.0, 900.0, 0.0, 0.0)
}

/// Runs mouse/keyboard input on the main thread (required on macOS).
fn input_on_main(app: &AppHandle, action: InputAction) -> anyhow::Result<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(sys::perform_input(&action));
    })?;
    rx.recv_timeout(std::time::Duration::from_secs(10)).map_err(|_| anyhow::anyhow!("input timed out"))?
}

pub struct AgentState {
    pub geometry: Option<ScreenGeometry>,
}

/// Executes the actions of one step. Blocking: call from `spawn_blocking`.
/// `on_activity(index, state, detail)` reports progress.
pub fn execute(app: &AppHandle, conversation_id: &str, actions: &[ActionCall], st: &mut AgentState, mut on_activity: impl FnMut(usize, &str, Option<String>)) -> StepResult {
    let state = app.state::<crate::state::AppState>();
    let settings = state.settings.read().clone();
    let mode = settings.computer.mode;
    let mut lines = vec![];
    let mut want_screenshot = false;
    let mut gui_touched = false;

    for (i, a) in actions.iter().enumerate() {
        let what = describe(a);
        if mode == ControlMode::Off {
            on_activity(i, "denied", Some("computer access is off".into()));
            lines.push(format!("- {}: not allowed — computer access is turned off in Settings.", a.name));
            continue;
        }
        if needs_approval(mode, &a.name) {
            let allowed = match &state.permissions {
                Some(p) => {
                    let input = if a.name == "run_command" { json!({ "command": a.payload }) } else { json!({ "action": a.name, "detail": what }) };
                    let ws = state.default_workspace.to_string_lossy().into_owned();
                    p.request(app, conversation_id, &ws, &a.name, input, Some(what.clone()))
                }
                None => Some(false),
            };
            if allowed != Some(true) {
                on_activity(i, "denied", Some(what.clone()));
                lines.push(format!("- {}: the user declined. Don't retry it; ask what they'd like instead.", what));
                // stop the remaining actions of this step
                break;
            }
        }
        on_activity(i, "running", Some(what.clone()));
        let geom = st.geometry;
        let need_xy = |a: &ActionCall| -> anyhow::Result<(i32, i32)> {
            let g = geom.ok_or_else(|| anyhow::anyhow!("take a screenshot first (see_screen) so coordinates make sense"))?;
            let x = a.num("x").ok_or_else(|| anyhow::anyhow!("missing x"))?;
            let y = a.num("y").ok_or_else(|| anyhow::anyhow!("missing y"))?;
            Ok(g.to_screen(x, y))
        };
        let result: anyhow::Result<String> = match a.name.as_str() {
            "see_screen" => {
                want_screenshot = true;
                Ok("screenshot attached below".into())
            }
            "open_app" => sys::open_app(&a.payload).inspect(|_| gui_touched = true),
            "open_url" => sys::open_url(&a.payload).inspect(|_| gui_touched = true),
            "click" => need_xy(a).and_then(|(x, y)| {
                gui_touched = true;
                input_on_main(app, InputAction::Click { x, y, right: a.attrs.get("button").map(|b| b == "right").unwrap_or(false), double: a.flag("double") })
            }),
            "move_mouse" => need_xy(a).and_then(|(x, y)| input_on_main(app, InputAction::Move(x, y))),
            "scroll" => {
                let at = if a.attrs.contains_key("x") { need_xy(a).ok() } else { None };
                gui_touched = true;
                let amount = a.num("amount").unwrap_or(3.0).round().clamp(-50.0, 50.0) as i32;
                input_on_main(app, InputAction::Scroll { x: at, amount })
            }
            "type" => {
                gui_touched = true;
                input_on_main(app, InputAction::Type(a.payload.clone()))
            }
            "key" => {
                gui_touched = true;
                input_on_main(app, InputAction::Keys(a.payload.clone()))
            }
            "run_command" => sys::run_command(&a.payload, &state.default_workspace, state.env_path.as_deref()).map(|o| {
                let mut s = format!("exit {}", o.exit_code.map(|c| c.to_string()).unwrap_or("?".into()));
                if !o.stdout.is_empty() {
                    s.push_str(&format!("\nstdout:\n{}", o.stdout));
                }
                if !o.stderr.is_empty() {
                    s.push_str(&format!("\nstderr:\n{}", o.stderr));
                }
                s
            }),
            "wait" => {
                std::thread::sleep(std::time::Duration::from_millis(a.num("ms").unwrap_or(600.0).clamp(50.0, 3000.0) as u64));
                Ok("waited".into())
            }
            other => Err(anyhow::anyhow!("unknown action \"{other}\"")),
        };
        match result {
            Ok(r) => {
                on_activity(i, "done", Some(what.clone()));
                lines.push(format!("- {what}: {r}"));
            }
            Err(e) => {
                on_activity(i, "error", Some(format!("{what}: {e:#}")));
                lines.push(format!("- {what}: FAILED — {e:#}"));
            }
        }
    }

    // Fresh screenshot when asked, or after anything that changed the screen.
    let mut image = None;
    if mode != ControlMode::Off && (want_screenshot || gui_touched) {
        if gui_touched {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        match sys::screenshot(primary_display(app), &state.cache_dir.join("shots")) {
            Ok(shot) => {
                st.geometry = Some(shot.geometry);
                lines.push(format!(
                    "Screen: {}. Screenshot is {}×{} px; use those pixel coordinates for clicks.",
                    shot.summary, shot.geometry.image_w, shot.geometry.image_h
                ));
                if settings.computer.send_screenshots {
                    image = Some(format!("data:image/jpeg;base64,{}", shot.jpeg_base64));
                } else {
                    lines.push("(Screenshots are not sent to you in the current settings; rely on the text above.)".into());
                }
            }
            Err(e) => lines.push(format!("Screenshot unavailable: {e:#}. Screen (text only): {}", sys::screen_summary())),
        }
    }
    StepResult { text: format!("[Results of your actions]\n{}\n\nContinue. If done, answer the user briefly without tags.", lines.join("\n")), image_data_url: image }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_hides_tags_across_chunks() {
        let mut f = TagFilter::default();
        let mut out = String::new();
        for c in ["Opening it", " now. <ac", "tion name=\"open_app\">Saf", "ari</action> Done", " <remember>x</remember>!", " a < b"] {
            out.push_str(&f.push(c));
        }
        out.push_str(&f.finish());
        assert_eq!(out, "Opening it now.  Done ! a < b");
    }

    #[test]
    fn filter_handles_self_closing() {
        let mut f = TagFilter::default();
        let s = f.push("Look: <action name=\"see_screen\" /> ok");
        assert_eq!(s + &f.finish(), "Look:  ok");
    }

    #[test]
    fn filter_drops_unfinished_tag_at_end() {
        let mut f = TagFilter::default();
        assert_eq!(f.push("Hi <action name=\"cl"), "Hi ");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn parses_actions_with_attributes() {
        let (clean, mems, acts) = parse_reply("Clicking. <action name=\"click\" x=\"10\" y='20' double=\"true\"/> <action name=\"type\">hello</action><remember>likes cats</remember>");
        assert_eq!(clean, "Clicking.");
        assert_eq!(mems, vec!["likes cats"]);
        assert_eq!(acts.len(), 2);
        assert_eq!(acts[0].name, "click");
        assert_eq!(acts[0].num("x"), Some(10.0));
        assert_eq!(acts[0].num("y"), Some(20.0));
        assert!(acts[0].flag("double"));
        assert_eq!(acts[1].payload, "hello");
    }

    #[test]
    fn approval_rules() {
        assert!(!needs_approval(ControlMode::Ask, "see_screen"));
        assert!(needs_approval(ControlMode::Ask, "click"));
        assert!(!needs_approval(ControlMode::Trusted, "click"));
        assert!(needs_approval(ControlMode::Trusted, "run_command"));
    }

    #[test]
    fn tool_call_tags_are_hidden_and_parsed() {
        let mut f = TagFilter::default();
        let shown = f.push("Let me look.\n<tool_") + &f.push("call>{\"name\": \"see_screen\", \"arguments\": {}}</tool_call> ok") + &f.finish();
        assert_eq!(shown, "Let me look.\n ok");
        let mut f = TagFilter::default();
        assert_eq!(f.push("Done.</tool_call> Next") + &f.finish(), "Done. Next");
        let (clean, _, acts) = parse_reply("Opening.<tool_call>{\"name\":\"open_app\",\"arguments\":{\"app\":\"Safari\"}}</tool_call>");
        assert_eq!(clean, "Opening.");
        assert_eq!((acts[0].name.as_str(), acts[0].payload.as_str()), ("open_app", "Safari"));
        let (_, _, acts) = parse_reply("<tool_call>{\"name\":\"click\",\"arguments\":\"{\\\"x\\\": 10, \\\"y\\\": 20}\"}</tool_call>");
        assert_eq!(acts[0].attrs.get("x").map(String::as_str), Some("10"));
    }
}
