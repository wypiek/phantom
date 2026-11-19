//! IPC commands for settings, conversations, memories, providers and app control.

use crate::providers::{claude_code, groq, openrouter};
use crate::secrets;
use crate::settings::Settings;
use crate::state::{err, AppState, CmdResult};
use crate::storage::{Conversation, Memory, Message};
use crate::windows;
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

/// Saves current settings to disk and tells every window.
pub fn persist_and_broadcast(app: &AppHandle) {
    let state = app.state::<AppState>();
    let s = state.settings.read().clone();
    if let Err(e) = s.save(&state.settings_path) {
        log::error!("saving settings failed: {e:#}");
    }
    let _ = app.emit("settings://changed", &s);
}

// ---- settings ----------------------------------------------------------------

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.read().clone()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    settings: Settings,
    warnings: Vec<String>,
}

#[tauri::command]
pub fn settings_update(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> CmdResult<SettingsUpdate> {
    let new = settings.sanitize();
    let old = state.settings.read().clone();
    *state.settings.write() = new.clone();
    let mut warnings = vec![];

    windows::apply_companion_settings(&app, &new);
    if old.general.character_visible != new.general.character_visible {
        windows::set_companion_visible(&app, new.general.character_visible);
    }
    if old.general.shortcuts != new.general.shortcuts {
        warnings.extend(windows::register_shortcuts(&app, &new));
    }
    if old.general.launch_at_startup != new.general.launch_at_startup {
        let al = app.autolaunch();
        let r = if new.general.launch_at_startup { al.enable() } else { al.disable() };
        if let Err(e) = r {
            warnings.push(format!("Could not change launch-at-startup: {e}"));
        }
    }
    if !new.voice.enabled && old.voice.enabled {
        state.voice.stt.unload();
    }
    if old.privacy.history_retention_days != new.privacy.history_retention_days || old.privacy.memory_retention_days != new.privacy.memory_retention_days {
        let _ = state.storage.apply_retention(new.privacy.history_retention_days, new.privacy.memory_retention_days);
        let _ = app.emit("conversations://changed", ());
        let _ = app.emit("memories://changed", ());
    }
    persist_and_broadcast(&app);
    Ok(SettingsUpdate { settings: new, warnings })
}

#[tauri::command]
pub fn settings_reset(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Settings> {
    let mut fresh = Settings::default();
    // keep onboarding + window placement
    {
        let cur = state.settings.read();
        fresh.general.onboarding_complete = cur.general.onboarding_complete;
        fresh.general.position = cur.general.position.clone();
    }
    settings_update(app, state, fresh).map(|u| u.settings)
}

// ---- conversations -------------------------------------------------------------

#[tauri::command]
pub fn conversations_list(state: State<'_, AppState>, query: Option<String>) -> CmdResult<Vec<Conversation>> {
    state.storage.list_conversations(query.as_deref()).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetail {
    conversation: Conversation,
    messages: Vec<Message>,
    running: bool,
}

#[tauri::command]
pub fn conversation_get(state: State<'_, AppState>, id: String) -> CmdResult<ConversationDetail> {
    let conversation = state.storage.get_conversation(&id).map_err(err)?.ok_or("conversation not found")?;
    let messages = state.storage.messages(&id).map_err(err)?;
    let running = state.generations.lock().contains_key(&id);
    Ok(ConversationDetail { conversation, messages, running })
}

#[tauri::command]
pub fn conversation_create(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Conversation> {
    let c = state.storage.create_conversation(crate::chat::NEW_TITLE).map_err(err)?;
    *state.active_conversation.lock() = Some(c.id.clone());
    let _ = app.emit("conversations://changed", &c.id);
    Ok(c)
}

#[tauri::command]
pub fn conversation_rename(app: AppHandle, state: State<'_, AppState>, id: String, title: String) -> CmdResult<()> {
    let t = title.trim();
    if t.is_empty() {
        return Err("Title cannot be empty".into());
    }
    state.storage.rename_conversation(&id, t).map_err(err)?;
    let _ = app.emit("conversations://changed", &id);
    Ok(())
}

#[tauri::command]
pub fn conversation_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if let Some(t) = state.generations.lock().get(&id) {
        t.cancel();
    }
    state.storage.delete_conversation(&id).map_err(err)?;
    {
        let mut active = state.active_conversation.lock();
        if active.as_deref() == Some(&id) {
            *active = None;
        }
    }
    let _ = app.emit("conversations://changed", &id);
    Ok(())
}

#[tauri::command]
pub fn conversation_clear(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if state.generations.lock().contains_key(&id) {
        return Err("Stop the current answer first.".into());
    }
    state.storage.clear_conversation(&id).map_err(err)?;
    let _ = app.emit("conversations://changed", &id);
    Ok(())
}

#[tauri::command]
pub fn conversations_delete_all(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    for t in state.generations.lock().values() {
        t.cancel();
    }
    state.storage.delete_all_conversations().map_err(err)?;
    *state.active_conversation.lock() = None;
    let _ = app.emit("conversations://changed", ());
    Ok(())
}

/// Writes a conversation export to `path` ("markdown" or "json").
#[tauri::command]
pub fn conversation_export(state: State<'_, AppState>, id: String, format: String, path: String) -> CmdResult<()> {
    let data = match format.as_str() {
        "json" => state.storage.export_json(&id),
        _ => state.storage.export_markdown(&id),
    }
    .map_err(err)?;
    std::fs::write(&path, data).map_err(err)
}

// ---- memories --------------------------------------------------------------------

#[tauri::command]
pub fn memories_list(state: State<'_, AppState>) -> CmdResult<Vec<Memory>> {
    state.storage.memories().map_err(err)
}

#[tauri::command]
pub fn memory_add(app: AppHandle, state: State<'_, AppState>, content: String) -> CmdResult<Memory> {
    if content.trim().is_empty() {
        return Err("Memory is empty".into());
    }
    let m = state.storage.add_memory(&content, None).map_err(err)?;
    let _ = app.emit("memories://changed", ());
    Ok(m)
}

#[tauri::command]
pub fn memory_update(app: AppHandle, state: State<'_, AppState>, id: String, content: String) -> CmdResult<()> {
    state.storage.update_memory(&id, &content).map_err(err)?;
    let _ = app.emit("memories://changed", ());
    Ok(())
}

#[tauri::command]
pub fn memory_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.storage.delete_memory(&id).map_err(err)?;
    let _ = app.emit("memories://changed", ());
    Ok(())
}

#[tauri::command]
pub fn memories_clear(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    state.storage.delete_all_memories().map_err(err)?;
    let _ = app.emit("memories://changed", ());
    Ok(())
}

// ---- providers -------------------------------------------------------------------

#[tauri::command]
pub async fn claude_status(state: State<'_, AppState>) -> CmdResult<claude_code::ClaudeStatus> {
    let s = state.settings.read().clone();
    Ok(claude_code::status(&s, state.env_path.as_deref()).await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    path: String,
    is_default: bool,
}

#[tauri::command]
pub fn claude_workspace(state: State<'_, AppState>) -> CmdResult<WorkspaceInfo> {
    let s = state.settings.read().clone();
    let p = claude_code::resolve_workspace(&s, &state.default_workspace).map_err(err)?;
    Ok(WorkspaceInfo { path: p.to_string_lossy().into_owned(), is_default: s.provider.claude_code.working_directory.trim().is_empty() })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    configured: bool,
    hint: Option<String>,
}

#[tauri::command]
pub fn openrouter_key_status() -> CmdResult<KeyStatus> {
    let key = secrets::get(secrets::OPENROUTER_KEY).map_err(err)?;
    Ok(KeyStatus { configured: key.is_some(), hint: key.as_deref().map(secrets::mask) })
}

/// Stores the key in the OS credential store. The key is write-only from the UI's perspective.
#[tauri::command]
pub fn openrouter_set_key(key: String) -> CmdResult<KeyStatus> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("API key is empty".into());
    }
    if key.chars().any(char::is_whitespace) {
        return Err("API key contains spaces — check that it was pasted correctly.".into());
    }
    secrets::set(secrets::OPENROUTER_KEY, &key).map_err(err)?;
    openrouter_key_status()
}

#[tauri::command]
pub fn openrouter_delete_key() -> CmdResult<()> {
    secrets::delete(secrets::OPENROUTER_KEY).map_err(err)
}

/// Tests the stored key, or `candidate` before saving it.
#[tauri::command]
pub async fn openrouter_test(state: State<'_, AppState>, candidate: Option<String>) -> CmdResult<openrouter::KeyCheck> {
    let base = state.settings.read().provider.openrouter.base_url.clone();
    openrouter::test_key(&state.provider_context(), &base, candidate.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn openrouter_models(state: State<'_, AppState>, refresh: Option<bool>) -> CmdResult<Vec<openrouter::ModelInfo>> {
    if !refresh.unwrap_or(false) {
        if let Some((at, models)) = state.models_cache.lock().as_ref() {
            if at.elapsed() < Duration::from_secs(3600) {
                return Ok(models.clone());
            }
        }
    }
    let base = state.settings.read().provider.openrouter.base_url.clone();
    let models = openrouter::list_models(&state.provider_context(), &base).await.map_err(err)?;
    *state.models_cache.lock() = Some((Instant::now(), models.clone()));
    Ok(models)
}

// ---- groq --------------------------------------------------------------------

#[tauri::command]
pub fn groq_key_status() -> CmdResult<KeyStatus> {
    let key = secrets::get(secrets::GROQ_KEY).map_err(err)?;
    Ok(KeyStatus { configured: key.is_some(), hint: key.as_deref().map(secrets::mask) })
}

#[tauri::command]
pub fn groq_set_key(key: String) -> CmdResult<KeyStatus> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("API key is empty".into());
    }
    if key.chars().any(char::is_whitespace) {
        return Err("API key contains spaces — check that it was pasted correctly.".into());
    }
    secrets::set(secrets::GROQ_KEY, &key).map_err(err)?;
    groq_key_status()
}

#[tauri::command]
pub fn groq_delete_key() -> CmdResult<()> {
    secrets::delete(secrets::GROQ_KEY).map_err(err)
}

#[tauri::command]
pub async fn groq_test(state: State<'_, AppState>, candidate: Option<String>) -> CmdResult<groq::KeyCheck> {
    let base = state.settings.read().provider.groq.base_url.clone();
    groq::test_key(&state.provider_context(), &base, candidate.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn groq_models(state: State<'_, AppState>, refresh: Option<bool>) -> CmdResult<Vec<groq::GroqModelInfo>> {
    if !refresh.unwrap_or(false) {
        if let Some((at, models)) = state.groq_models_cache.lock().as_ref() {
            if at.elapsed() < Duration::from_secs(3600) {
                return Ok(models.clone());
            }
        }
    }
    let base = state.settings.read().provider.groq.base_url.clone();
    let models = groq::list_models(&state.provider_context(), &base).await.map_err(err)?;
    *state.groq_models_cache.lock() = Some((Instant::now(), models.clone()));
    Ok(models)
}

// ---- permissions -----------------------------------------------------------------

#[tauri::command]
pub fn permission_respond(state: State<'_, AppState>, id: String, allow: bool, remember: Option<bool>) -> bool {
    state.permissions.as_ref().map(|p| p.respond(&id, allow, remember.unwrap_or(false))).unwrap_or(false)
}

#[tauri::command]
pub fn permission_pending(state: State<'_, AppState>) -> Vec<crate::permission::PermissionRequest> {
    state.permissions.as_ref().map(|p| p.pending()).unwrap_or_default()
}

// ---- app / windows ---------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    platform: String,
    data_dir: String,
    default_workspace: String,
    permission_bridge: bool,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        default_workspace: state.default_workspace.to_string_lossy().into_owned(),
        permission_bridge: state.permissions.is_some(),
    }
}

#[tauri::command]
pub fn open_window(app: AppHandle, label: String, section: Option<String>) {
    match label.as_str() {
        "chat" => windows::open_chatbox(&app, false),
        "settings" => windows::show_settings(&app, section),
        "companion" => windows::set_companion_visible(&app, true),
        _ => {}
    }
}

#[tauri::command]
pub fn companion_toggle(app: AppHandle) {
    windows::toggle_companion(&app);
}

#[tauri::command]
pub fn companion_set_visible(app: AppHandle, visible: bool) {
    windows::set_companion_visible(&app, visible);
}

/// Saves the companion position (logical px) after the user drags it.
#[tauri::command]
pub fn companion_save_position(state: State<'_, AppState>, x: f64, y: f64) {
    {
        let mut s = state.settings.write();
        s.general.position = Some(crate::settings::Position { x, y });
    }
    let s = state.settings.read().clone();
    let _ = s.save(&state.settings_path);
}

/// The companion grows to fit its chatbox and shrinks back when it closes.
#[tauri::command]
pub fn companion_set_expanded(app: AppHandle, expanded: bool) {
    windows::set_expanded(&app, expanded);
}

#[tauri::command]
pub fn show_menu(app: AppHandle, id: String) {
    windows::handle_menu(&app, &id);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn reveal_data_dir(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(state.data_dir.to_string_lossy(), None::<&str>).map_err(err)
}

// ---- computer control ------------------------------------------------------------

/// Whether the OS lets Noli see the screen and use the mouse/keyboard.
#[tauri::command]
pub fn computer_permissions() -> crate::system_tools::ControlPermissions {
    crate::system_tools::permissions()
}

/// Restarts PHANTOM (some macOS permissions only apply after a relaunch).
#[tauri::command]
pub fn app_restart(app: AppHandle) {
    app.restart();
}

/// Opens the OS settings page for "screen" or "accessibility".
#[tauri::command]
pub fn computer_open_permission(which: String) {
    crate::system_tools::open_permission_settings(&which);
}
