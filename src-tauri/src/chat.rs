//! Chat orchestration: persists messages, builds the prompt (personality +
//! memories), runs the active provider and broadcasts streaming events to
//! every window (`chat://event`). The companion window uses these events to
//! drive animations and speech; the chat window renders them.

use crate::providers::{self, Activity, ChatTurn, ProviderEvent, ProviderRequest};
use crate::settings::{ProviderKind, Settings};
use crate::state::{err, AppState, CmdResult};
use crate::storage::{new_id, now_ms, Message};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

pub const NEW_TITLE: &str = "New conversation";

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatEvent {
    pub conversation_id: String,
    pub message_id: String,
    /// start | delta | activity | done | error | cancelled
    pub kind: String,
    pub delta: Option<String>,
    pub content: Option<String>,
    pub activity: Option<Activity>,
    pub error: Option<String>,
    pub source: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub conversation_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
}

/// Splits `<remember>…</remember>` tags out of a reply (actions are dropped).
#[allow(dead_code)]
pub fn extract_memories(text: &str) -> (String, Vec<String>) {
    let (clean, mems, _) = crate::agent::parse_reply(text);
    (clean, mems)
}

/// Removes roleplay narration lines like "*the screen flickers*" or "(sighs)".
pub fn strip_roleplay(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| {
            let t = l.trim();
            let wrapped = |o: char, c: char| t.len() > 2 && t.starts_with(o) && t.ends_with(c) && !t[1..t.len() - 1].contains(o);
            !(wrapped('*', '*') || wrapped('_', '_') || (wrapped('(', ')') && t.split_whitespace().count() <= 6))
        })
        .collect();
    let joined = lines.join("\n");
    // inline "*sighs*" style actions
    let mut out = String::with_capacity(joined.len());
    let mut rest = joined.as_str();
    while let Some(a) = rest.find('*') {
        let after = &rest[a + 1..];
        // **bold** is markdown, not an action: copy it through untouched
        if let Some(bold) = after.strip_prefix('*') {
            let end = bold.find("**").map(|e| e + 2).unwrap_or(bold.len());
            out.push_str(&rest[..a + 2 + end]);
            rest = &bold[end..];
            continue;
        }
        match after.find('*') {
            Some(b) if b > 0 && !after[..b].contains('\n') && after[..b].split_whitespace().count() <= 8 && !after[..b].starts_with(' ') && !after[b + 1..].starts_with('*') => {
                out.push_str(rest[..a].trim_end_matches(' '));
                rest = &after[b + 1..];
            }
            _ => {
                out.push_str(&rest[..=a]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

pub fn make_title(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= 48 {
        one_line
    } else {
        let cut: String = one_line.chars().take(46).collect();
        let cut = cut.rsplit_once(' ').map(|(a, _)| a.to_string()).unwrap_or(cut);
        format!("{cut}…")
    }
}

pub fn build_system_prompt(settings: &Settings, memories: &[String]) -> String {
    let mut s = settings.personality.system_prompt.trim().to_string();
    let now = chrono::Local::now().format("%A, %B %-d %Y, %H:%M");
    s.push_str(&format!("\n\nContext: you speak through the Noli desktop companion, a small animated creature on the user's desktop. Local time: {now}. Reply in plain dialogue only — no roleplay narration, no actions in asterisks, no stage directions."));
    s.push_str(&crate::agent::tool_prompt(settings));
    if settings.privacy.memory_enabled {
        if !memories.is_empty() {
            s.push_str("\n\nThings you remember about the user from earlier conversations:\n");
            for m in memories.iter().take(60) {
                s.push_str(&format!("- {m}\n"));
            }
        }
        s.push_str("\n\nMemory: if the user shares a lasting fact or preference that would be useful in future conversations, append it at the very end of your reply as <remember>one short fact</remember>. Do this rarely, never for trivia, and never mention the tags.");
    }
    s
}

fn emit(app: &AppHandle, ev: ChatEvent) {
    let _ = app.emit("chat://event", ev);
}

/// A conversation idle this long is closed; the next message starts a new one.
const STALE_AFTER_MS: i64 = 45 * 60_000;
/// Only the most recent part of a long conversation is sent to the model.
const HISTORY_MAX_TURNS: usize = 30;
const HISTORY_MAX_CHARS: usize = 24_000;

fn is_stale(updated_at: i64, message_count: i64, now: i64) -> bool {
    message_count > 0 && now - updated_at > STALE_AFTER_MS
}

/// Keeps the newest turns within both limits, always starting on a user turn.
fn trim_history(turns: Vec<ChatTurn>, max_turns: usize, max_chars: usize) -> Vec<ChatTurn> {
    let mut kept = 0;
    let mut chars = 0;
    for t in turns.iter().rev() {
        if kept == max_turns || (kept > 0 && chars + t.content.len() > max_chars) {
            break;
        }
        chars += t.content.len();
        kept += 1;
    }
    let mut out: Vec<ChatTurn> = turns.into_iter().rev().take(kept).collect();
    out.reverse();
    while out.first().is_some_and(|t| t.role != "user") {
        out.remove(0);
    }
    out
}

fn history_turns(messages: &[Message]) -> Vec<ChatTurn> {
    messages
        .iter()
        .filter(|m| (m.role == "user" || m.role == "assistant") && !m.content.trim().is_empty() && m.status != "error")
        .map(|m| ChatTurn { role: m.role.clone(), content: m.content.clone() })
        .collect()
}

async fn start_generation(app: AppHandle, conversation_id: Option<String>, text: String, source: Option<String>) -> anyhow::Result<SendResult> {
    let state = app.state::<AppState>();
    let text = text.trim().to_string();
    if text.is_empty() {
        anyhow::bail!("Say something first.");
    }
    let storage = state.storage.clone();
    // After a long break Noli starts a fresh conversation (memories carry over),
    // which keeps replies quick and on-topic. An explicitly chosen one is kept.
    let explicit = conversation_id.is_some();
    let conv = match conversation_id.or_else(|| state.active_conversation.lock().clone()) {
        Some(id) => match storage.get_conversation(&id)? {
            Some(c) if explicit || !is_stale(c.updated_at, c.message_count, now_ms()) => c,
            _ => storage.create_conversation(&make_title(&text))?,
        },
        None => storage.create_conversation(&make_title(&text))?,
    };
    if state.generations.lock().contains_key(&conv.id) {
        anyhow::bail!("Noli is still answering in this conversation — stop it first.");
    }
    let settings = state.settings.read().clone();
    let kind = settings.provider.active;
    let provider_id = providers::kind_id(kind).to_string();

    let prior = storage.messages(&conv.id)?;
    let history = trim_history(history_turns(&prior), HISTORY_MAX_TURNS, HISTORY_MAX_CHARS);
    if prior.is_empty() && conv.title == NEW_TITLE {
        storage.rename_conversation(&conv.id, &make_title(&text))?;
    }

    let user_msg = Message {
        id: new_id(),
        conversation_id: conv.id.clone(),
        role: "user".into(),
        content: text.clone(),
        created_at: now_ms(),
        provider: None,
        model: None,
        status: "complete".into(),
        error: None,
        activity: None,
    };
    storage.add_message(&user_msg)?;
    let assistant_id = new_id();
    storage.add_message(&Message {
        id: assistant_id.clone(),
        conversation_id: conv.id.clone(),
        role: "assistant".into(),
        content: String::new(),
        created_at: now_ms() + 1,
        provider: Some(provider_id.clone()),
        model: None,
        status: "streaming".into(),
        error: None,
        activity: None,
    })?;
    storage.touch_conversation(&conv.id, None)?;
    *state.active_conversation.lock() = Some(conv.id.clone());
    let _ = app.emit("conversations://changed", &conv.id);

    // Claude Code keeps its own context: resume only if it produced the last reply.
    let resume_session = if kind == ProviderKind::ClaudeCode && conv.provider.as_deref() == Some("claude-code") { conv.claude_session_id.clone() } else { None };
    let memories: Vec<String> = if settings.privacy.memory_enabled { storage.memories()?.into_iter().map(|m| m.content).collect() } else { vec![] };
    let req = ProviderRequest {
        conversation_id: conv.id.clone(),
        system_prompt: build_system_prompt(&settings, &memories),
        history,
        user_message: text.clone(),
        resume_session,
        user_images: vec![],
        settings: settings.clone(),
    };

    let cancel = CancellationToken::new();
    state.generations.lock().insert(conv.id.clone(), cancel.clone());
    emit(&app, ChatEvent {
        conversation_id: conv.id.clone(),
        message_id: assistant_id.clone(),
        kind: "start".into(),
        source: source.clone(),
        provider: Some(provider_id.clone()),
        ..Default::default()
    });

    let result = SendResult { conversation_id: conv.id.clone(), user_message_id: user_msg.id.clone(), assistant_message_id: assistant_id.clone() };
    let ctx = state.provider_context();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        run_generation(app2, ctx, kind, req, assistant_id, cancel, source, provider_id).await;
    });
    Ok(result)
}

/// Images make some models fail; detect that so we can retry text-only.
fn looks_like_image_error(e: &str) -> bool {
    let e = e.to_lowercase();
    ["image", "vision", "multimodal", "content must be a string", "image_url", "unsupported content"].iter().any(|k| e.contains(k))
}

#[allow(clippy::too_many_arguments)]
async fn run_generation(
    app: AppHandle,
    ctx: providers::ProviderContext,
    kind: ProviderKind,
    mut req: ProviderRequest,
    message_id: String,
    cancel: CancellationToken,
    source: Option<String>,
    provider_id: String,
) {
    let conv_id = req.conversation_id.clone();
    let base = ChatEvent { conversation_id: conv_id.clone(), message_id: message_id.clone(), source: source.clone(), provider: Some(provider_id.clone()), ..Default::default() };
    let max_steps = req.settings.computer.max_steps.clamp(1, 20) as usize;
    let mut visible = String::new();
    let mut memories_all: Vec<String> = vec![];
    let mut activities: Vec<Activity> = vec![];
    let mut model: Option<String> = None;
    let mut session: Option<String> = None;
    let mut outcome: anyhow::Result<()> = Ok(());
    let mut agent_state = crate::agent::AgentState { geometry: None };

    for step in 0..max_steps {
        // ---- one model turn, streamed through the tag filter ----
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (cancel2, ctx2, step_req) = (cancel.clone(), ctx.clone(), req.clone());
        let task = tokio::spawn(async move { providers::run(kind, &ctx2, step_req, tx, cancel2).await });
        let mut raw = String::new();
        let mut filter = crate::agent::TagFilter::default();
        let mut step_visible = String::new();
        let emit_visible = |text: String, visible: &mut String, step_visible: &mut String| {
            if text.is_empty() {
                return;
            }
            let text = if step_visible.is_empty() && !visible.trim().is_empty() { format!("\n\n{}", text.trim_start()) } else { text };
            step_visible.push_str(&text);
            visible.push_str(&text);
            emit(&app, ChatEvent { kind: "delta".into(), delta: Some(text), ..base.clone() });
        };
        while let Some(ev) = rx.recv().await {
            match ev {
                ProviderEvent::Delta(d) => {
                    raw.push_str(&d);
                    let shown = filter.push(&d);
                    emit_visible(shown, &mut visible, &mut step_visible);
                }
                ProviderEvent::Activity(a) => {
                    match activities.iter_mut().find(|x| x.id == a.id) {
                        Some(x) => *x = a.clone(),
                        None => activities.push(a.clone()),
                    }
                    emit(&app, ChatEvent { kind: "activity".into(), activity: Some(a), ..base.clone() });
                }
                ProviderEvent::SessionId(s) => session = Some(s),
                ProviderEvent::Model(m) => model = Some(m),
            }
        }
        let tail = filter.finish();
        emit_visible(tail, &mut visible, &mut step_visible);
        let res = task.await.map_err(|e| anyhow::anyhow!("provider task failed: {e}")).and_then(|r| r);
        match res {
            Ok(o) => {
                model = o.model.or(model);
                session = o.session_id.or(session);
            }
            Err(e) => {
                let msg = format!("{e:#}");
                // A model without vision choked on the screenshot: retry this step without it.
                if !req.user_images.is_empty() && raw.is_empty() && looks_like_image_error(&msg) {
                    req.user_images.clear();
                    req.user_message.push_str("\n\n(The screenshot could not be attached because the current model can't read images. Use the text description above. Tell the user that seeing the screen needs a vision-capable model.)");
                    continue;
                }
                outcome = Err(e);
                break;
            }
        }
        if cancel.is_cancelled() {
            break;
        }

        // ---- run requested actions, then feed results back ----
        let (_, mems, actions) = crate::agent::parse_reply(&raw);
        memories_all.extend(mems);
        if actions.is_empty() || step + 1 == max_steps {
            if !actions.is_empty() {
                let note = "I stopped there — that task needed more steps than I'm allowed in one go.";
                emit_visible(format!("\n\n{note}"), &mut visible, &mut step_visible);
            }
            break;
        }
        let ids: Vec<String> = actions.iter().map(|_| new_id()).collect();
        let (app2, conv2, acts2, ids2, mut st) = (app.clone(), conv_id.clone(), actions.clone(), ids.clone(), std::mem::replace(&mut agent_state, crate::agent::AgentState { geometry: None }));
        let base2 = base.clone();
        let (result, st, acts_out) = tauri::async_runtime::spawn_blocking(move || {
            let mut acts_out: Vec<Activity> = vec![];
            let r = crate::agent::execute(&app2, &conv2, &acts2, &mut st, |i, state, detail| {
                let (label, _) = crate::agent::activity_label(&acts2[i]);
                let a = Activity { id: ids2[i].clone(), kind: "tool".into(), label, detail, state: state.into() };
                emit(&app2, ChatEvent { kind: "activity".into(), activity: Some(a.clone()), ..base2.clone() });
                match acts_out.iter_mut().find(|x| x.id == a.id) {
                    Some(x) => *x = a,
                    None => acts_out.push(a),
                }
            });
            (r, st, acts_out)
        })
        .await
        .expect("agent task panicked");
        agent_state = st;
        for a in acts_out {
            match activities.iter_mut().find(|x| x.id == a.id) {
                Some(x) => *x = a,
                None => activities.push(a),
            }
        }
        if cancel.is_cancelled() {
            break;
        }
        // Next turn: the model sees its own reply and the results.
        req.history.push(ChatTurn { role: "user".into(), content: req.user_message.clone() });
        req.history.push(ChatTurn { role: "assistant".into(), content: raw.clone() });
        req.user_message = result.text;
        req.user_images = result.image_data_url.into_iter().collect();
        if kind == ProviderKind::ClaudeCode {
            req.resume_session = session.clone();
        }
    }

    let state = app.state::<AppState>();
    let storage = state.storage.clone();
    let settings = state.settings.read().clone();
    let clean = strip_roleplay(&visible);
    if settings.privacy.memory_enabled {
        for m in &memories_all {
            let _ = storage.add_memory(m, Some(&conv_id));
        }
        if !memories_all.is_empty() {
            let _ = app.emit("memories://changed", ());
        }
    }
    let activity_json = (!activities.is_empty()).then(|| serde_json::to_string(&activities).unwrap_or_default());
    let cancelled = cancel.is_cancelled();
    let (kind_str, status, error) = match &outcome {
        _ if cancelled => ("cancelled", "cancelled", None),
        Ok(_) => ("done", "complete", None),
        Err(e) => ("error", "error", Some(format!("{e:#}"))),
    };
    if kind == ProviderKind::ClaudeCode {
        if let Some(s) = &session {
            let _ = storage.set_claude_session(&conv_id, Some(s));
        }
    }
    let _ = storage.update_message(&message_id, &clean, status, error.as_deref(), activity_json.as_deref());
    if let Some(m) = &model {
        let _ = set_model(&storage, &message_id, m);
    }
    let _ = storage.touch_conversation(&conv_id, Some(&provider_id));
    state.generations.lock().remove(&conv_id);
    emit(&app, ChatEvent { kind: kind_str.into(), content: Some(clean), error, model, ..base });
    let _ = app.emit("conversations://changed", &conv_id);
}

fn set_model(storage: &crate::storage::Storage, message_id: &str, model: &str) -> anyhow::Result<()> {
    storage.set_message_model(message_id, model)
}

#[tauri::command]
pub async fn chat_send(app: AppHandle, conversation_id: Option<String>, text: String, source: Option<String>) -> CmdResult<SendResult> {
    start_generation(app, conversation_id, text, source).await.map_err(err)
}

#[tauri::command]
pub fn chat_cancel(state: State<'_, AppState>, conversation_id: String) -> bool {
    if let Some(p) = &state.permissions {
        p.deny_conversation(&conversation_id);
    }
    match state.generations.lock().get(&conversation_id) {
        Some(t) => {
            t.cancel();
            true
        }
        None => false,
    }
}

/// Cancels every running generation (used by "stop" voice interruptions).
#[tauri::command]
pub fn chat_cancel_all(state: State<'_, AppState>) {
    for (id, t) in state.generations.lock().iter() {
        t.cancel();
        if let Some(p) = &state.permissions {
            p.deny_conversation(id);
        }
    }
}

/// Removes the last exchange's reply and asks again (also used as "retry").
#[tauri::command]
pub async fn chat_regenerate(app: AppHandle, conversation_id: String) -> CmdResult<SendResult> {
    let state = app.state::<AppState>();
    if state.generations.lock().contains_key(&conversation_id) {
        return Err("Still answering — stop it first.".into());
    }
    let msgs = state.storage.messages(&conversation_id).map_err(err)?;
    let Some(last_user_idx) = msgs.iter().rposition(|m| m.role == "user") else {
        return Err("Nothing to regenerate yet.".into());
    };
    let text = msgs[last_user_idx].content.clone();
    for m in &msgs[last_user_idx..] {
        state.storage.delete_message(&m.id).map_err(err)?;
    }
    // The agent's session already contains the old answer; reseed from our history instead.
    state.storage.set_claude_session(&conversation_id, None).map_err(err)?;
    start_generation(app.clone(), Some(conversation_id), text, Some("regenerate".into())).await.map_err(err)
}

#[tauri::command]
pub fn chat_set_active(state: State<'_, AppState>, conversation_id: Option<String>) {
    // picking a conversation means "continue this one", so it is no longer stale
    if let Some(id) = &conversation_id {
        let _ = state.storage.touch_conversation(id, None);
    }
    *state.active_conversation.lock() = conversation_id;
}

#[tauri::command]
pub fn chat_get_active(state: State<'_, AppState>) -> Option<String> {
    state.active_conversation.lock().clone()
}

#[tauri::command]
pub fn chat_running(state: State<'_, AppState>) -> Vec<String> {
    state.generations.lock().keys().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: &str, content: &str) -> ChatTurn {
        ChatTurn { role: role.into(), content: content.into() }
    }

    #[test]
    fn history_is_trimmed_to_recent_turns() {
        let turns: Vec<ChatTurn> = (0..10).map(|i| turn(if i % 2 == 0 { "user" } else { "assistant" }, &format!("m{i}"))).collect();
        let t = trim_history(turns.clone(), 4, 10_000);
        assert_eq!(t.iter().map(|x| x.content.as_str()).collect::<Vec<_>>(), ["m6", "m7", "m8", "m9"]);
        // an odd limit would start on an assistant turn; that one is dropped
        let t = trim_history(turns.clone(), 3, 10_000);
        assert_eq!(t.first().unwrap().content, "m8");
        // char budget: always keeps at least the newest turn
        let big = vec![turn("user", &"x".repeat(50)), turn("assistant", &"y".repeat(50)), turn("user", &"z".repeat(50))];
        assert_eq!(trim_history(big, 30, 120).len(), 1);
    }

    #[test]
    fn conversations_go_stale_after_a_break() {
        let now = 10 * STALE_AFTER_MS;
        assert!(!is_stale(now - 60_000, 4, now));
        assert!(is_stale(now - STALE_AFTER_MS - 1, 4, now));
        assert!(!is_stale(0, 0, now), "an empty conversation is reused");
    }

    #[test]
    fn memory_tags_are_extracted() {
        let (clean, mems) = extract_memories("Noted, mortal.\n<remember>User's name is Ada</remember>");
        assert_eq!(clean, "Noted, mortal.");
        assert_eq!(mems, vec!["User's name is Ada"]);
        let (clean, mems) = extract_memories("No tags here.");
        assert_eq!(clean, "No tags here.");
        assert!(mems.is_empty());
        let (clean, _) = extract_memories("Half <remember>unterminated");
        assert_eq!(clean, "Half");
    }

    #[test]
    fn roleplay_is_stripped() {
        assert_eq!(strip_roleplay("*the screen dims, then flickers back*\n\nAh. Budget cuts."), "Ah. Budget cuts.");
        assert_eq!(strip_roleplay("Hello *waves* there."), "Hello there.");
        assert_eq!(strip_roleplay("2 * 3 * 4 = 24"), "2 * 3 * 4 = 24");
        assert_eq!(strip_roleplay("Use **bold** text."), "Use **bold** text.");
    }

    #[test]
    fn titles_are_short() {
        assert_eq!(make_title("  hello   there "), "hello there");
        let long = make_title("can you please explain to me how the quantum tunneling effect works in practice");
        assert!(long.ends_with('…') && long.chars().count() <= 48);
    }

    #[test]
    fn system_prompt_includes_memories_only_when_enabled() {
        let mut s = Settings::default();
        let p = build_system_prompt(&s, &["Likes tea".into()]);
        assert!(p.contains("Likes tea") && p.contains("<remember>"));
        s.privacy.memory_enabled = false;
        let p = build_system_prompt(&s, &["Likes tea".into()]);
        assert!(!p.contains("Likes tea") && !p.contains("<remember>"));
    }
}
