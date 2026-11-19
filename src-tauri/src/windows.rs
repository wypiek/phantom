//! Native windows, system tray and global shortcuts.
//!
//! PHANTOM has no chat window: the creature lives in a transparent companion
//! window that expands to show a small chatbox and its replies. Settings is the
//! only regular "app" window.

use crate::settings::Settings;
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub const COMPANION: &str = "companion";
pub const SETTINGS: &str = "settings";

/// Atlas cell aspect (width / height) — matches public/sprites/phantom-atlas.json.
const CELL_ASPECT: f64 = 124.0 / 128.0;
/// Room above the sprite for the speech bubble.
pub const BUBBLE_SPACE: f64 = 96.0;
/// Extra room while the chatbox is open (reply bubble + input line).
pub const CHAT_SPACE: f64 = 210.0;
pub const CHAT_MIN_WIDTH: f64 = 360.0;

/// Whether the companion is expanded with its chatbox.
static EXPANDED: AtomicBool = AtomicBool::new(false);

pub fn companion_size(character_size: u32, expanded: bool) -> (f64, f64) {
    let h = character_size as f64;
    let mut w = (h * CELL_ASPECT).max(240.0);
    let mut height = h + BUBBLE_SPACE;
    if expanded {
        w = w.max(CHAT_MIN_WIDTH);
        height += CHAT_SPACE;
    }
    (w.round(), height.round())
}

pub fn create_companion(app: &AppHandle, settings: &Settings) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(COMPANION) {
        return Ok(w);
    }
    let (w, h) = companion_size(settings.general.character_size, false);
    let mut b = WebviewWindowBuilder::new(app, COMPANION, WebviewUrl::App("index.html".into()))
        .title("PHANTOM")
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(settings.general.always_on_top)
        .visible_on_all_workspaces(true)
        .focused(false)
        .visible(false);
    let (x, y) = match settings.general.position.clone() {
        Some(p) => (p.x, p.y),
        None => default_position(app, w, h),
    };
    b = b.position(x, y);
    let win = b.build()?;
    if settings.general.click_through {
        let _ = win.set_ignore_cursor_events(true);
    }
    Ok(win)
}

fn default_position(app: &AppHandle, w: f64, h: f64) -> (f64, f64) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let scale = m.scale_factor();
        let size = m.size().to_logical::<f64>(scale);
        let origin = m.position().to_logical::<f64>(scale);
        return (origin.x + size.width - w - 48.0, origin.y + size.height - h - 72.0);
    }
    (200.0, 200.0)
}

/// Returns the settings window and whether it already existed. A new window
/// opens on `section` via the URL hash (it can't receive events before it loads).
fn settings_window(app: &AppHandle, section: Option<&str>) -> tauri::Result<(WebviewWindow, bool)> {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        return Ok((w, true));
    }
    let url = match section {
        Some(s) if s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => format!("index.html#{s}"),
        _ => "index.html".into(),
    };
    #[allow(unused_mut)] // only adjusted on macOS
    let mut b = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App(url.into()))
        .title("PHANTOM Settings")
        .inner_size(920.0, 680.0)
        .min_inner_size(640.0, 480.0)
        .background_color(tauri::window::Color(9, 7, 14, 255))
        .visible(false);
    #[cfg(target_os = "macos")]
    {
        b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    b.build().map(|w| (w, false))
}

pub fn show_settings(app: &AppHandle, section: Option<String>) {
    let app2 = app.clone();
    // Window creation must happen on the main thread.
    let _ = app.run_on_main_thread(move || {
        if let Ok((w, existed)) = settings_window(&app2, section.as_deref()) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            if let (Some(s), true) = (section, existed) {
                let _ = w.emit("settings://section", s);
            }
        }
    });
}

/// Shows the creature and opens (or toggles) its chatbox.
pub fn open_chatbox(app: &AppHandle, toggle: bool) {
    set_companion_visible(app, true);
    if let Some(w) = app.get_webview_window(COMPANION) {
        let _ = w.set_focus();
    }
    let _ = app.emit_to(COMPANION, "companion://command", if toggle { "chatbox-toggle" } else { "chatbox-open" });
}

/// Grows/shrinks the companion window for the chatbox, keeping the feet in place.
pub fn set_expanded(app: &AppHandle, expanded: bool) {
    EXPANDED.store(expanded, Ordering::Relaxed);
    let s = app.state::<AppState>().settings.read().clone();
    apply_companion_settings(app, &s);
    if expanded {
        if let Some(w) = app.get_webview_window(COMPANION) {
            let _ = w.set_focus();
        }
    }
}

pub fn set_companion_visible(app: &AppHandle, visible: bool) {
    if let Some(w) = app.get_webview_window(COMPANION) {
        if visible {
            let _ = w.show();
        } else {
            let _ = w.hide();
        }
    }
    let state = app.state::<AppState>();
    let changed = {
        let mut s = state.settings.write();
        let changed = s.general.character_visible != visible;
        s.general.character_visible = visible;
        changed
    };
    if changed {
        crate::commands::persist_and_broadcast(app);
    }
}

pub fn toggle_companion(app: &AppHandle) {
    let visible = app.get_webview_window(COMPANION).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    set_companion_visible(app, !visible);
}

/// Applies window-related settings to the live companion window.
pub fn apply_companion_settings(app: &AppHandle, s: &Settings) {
    if let Some(w) = app.get_webview_window(COMPANION) {
        let _ = w.set_always_on_top(s.general.always_on_top);
        // Click-through would make the chatbox unusable, so it pauses while open.
        let _ = w.set_ignore_cursor_events(s.general.click_through && !EXPANDED.load(Ordering::Relaxed));
        let (cw, ch) = companion_size(s.general.character_size, EXPANDED.load(Ordering::Relaxed));
        if let Ok(cur) = w.inner_size() {
            let scale = w.scale_factor().unwrap_or(1.0);
            let cur = cur.to_logical::<f64>(scale);
            if (cur.width - cw).abs() > 1.0 || (cur.height - ch).abs() > 1.0 {
                // keep the feet anchored (bottom-centre) when resizing
                if let Ok(pos) = w.outer_position() {
                    let pos = pos.to_logical::<f64>(scale);
                    let _ = w.set_size(LogicalSize::new(cw, ch));
                    let _ = w.set_position(LogicalPosition::new(pos.x + (cur.width - cw) / 2.0, pos.y + (cur.height - ch)));
                }
            }
        }
    }
    if let Some(tray) = app.try_state::<TrayItems>() {
        let _ = tray.click_through.set_checked(s.general.click_through);
        let _ = tray.on_top.set_checked(s.general.always_on_top);
        let _ = tray.toggle.set_text(if s.general.character_visible { "Hide PHANTOM" } else { "Summon PHANTOM" });
    }
}

pub struct TrayItems {
    pub toggle: MenuItem<Wry>,
    pub click_through: CheckMenuItem<Wry>,
    pub on_top: CheckMenuItem<Wry>,
}

pub fn build_tray(app: &AppHandle, s: &Settings) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", if s.general.character_visible { "Hide PHANTOM" } else { "Summon PHANTOM" }, true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "Talk (chatbox)", true, None::<&str>)?;
    let click_through = CheckMenuItem::with_id(app, "click_through", "Click-through", true, s.general.click_through, None::<&str>)?;
    let on_top = CheckMenuItem::with_id(app, "on_top", "Always on Top", true, s.general.always_on_top, None::<&str>)?;
    let glitch = MenuItem::with_id(app, "glitch", "Poke It", true, None::<&str>)?;
    let history = MenuItem::with_id(app, "history", "Conversation History…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit PHANTOM", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&toggle, &chat, &sep()?, &click_through, &on_top, &glitch, &sep()?, &history, &settings, &quit])?;
    app.manage(TrayItems { toggle, click_through, on_top });
    let mut tb = TrayIconBuilder::with_id("phantom-tray")
        .tooltip("PHANTOM")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, ev| handle_menu(app, ev.id().as_ref()));
    if let Some(icon) = app.default_window_icon() {
        tb = tb.icon(icon.clone());
    }
    tb.build(app)?;
    Ok(())
}

pub fn handle_menu(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    match id {
        "toggle" => toggle_companion(app),
        "chat" => open_chatbox(app, false),
        "settings" => show_settings(app, None),
        "history" => show_settings(app, Some("history".into())),
        "click_through" | "on_top" => {
            {
                let mut s = state.settings.write();
                if id == "click_through" {
                    s.general.click_through = !s.general.click_through;
                } else {
                    s.general.always_on_top = !s.general.always_on_top;
                }
            }
            let s = state.settings.read().clone();
            apply_companion_settings(app, &s);
            crate::commands::persist_and_broadcast(app);
        }
        "glitch" => {
            let _ = app.emit_to(COMPANION, "companion://command", "poke");
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Modifier keys that can be used on their own for push-to-talk.
pub const MODIFIER_KEYS: &[&str] = &["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"];

pub fn is_modifier_key(accel: &str) -> bool {
    MODIFIER_KEYS.contains(&accel.trim())
}

/// Bumped whenever shortcuts are re-registered so an old modifier watcher exits.
static PTT_WATCH_GEN: AtomicU64 = AtomicU64::new(0);

/// (Re)registers global shortcuts from settings. Returns human-readable problems.
pub fn register_shortcuts(app: &AppHandle, s: &Settings) -> Vec<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let gen = PTT_WATCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let mut problems = vec![];
    let sc = &s.general.shortcuts;
    let ptt = sc.push_to_talk.trim();
    if is_modifier_key(ptt) {
        if let Err(e) = crate::modifier_key::watch(app.clone(), ptt.to_string(), gen, &PTT_WATCH_GEN) {
            problems.push(format!("Push-to-talk key \"{ptt}\": {e}"));
        }
    }
    let mut entries: Vec<(&str, &str)> = vec![(sc.toggle_character.as_str(), "toggle"), (sc.open_chat.as_str(), "chat")];
    if !is_modifier_key(ptt) {
        entries.push((ptt, "ptt"));
    }
    for (accel, action) in entries {
        if accel.trim().is_empty() {
            continue;
        }
        let action = action.to_string();
        let res = gs.on_shortcut(accel, move |app, _shortcut, event| match (action.as_str(), event.state()) {
            ("toggle", ShortcutState::Pressed) => toggle_companion(app),
            ("chat", ShortcutState::Pressed) => open_chatbox(app, true),
            ("ptt", st) => {
                let _ = app.emit_to(COMPANION, "shortcut://ptt", serde_json::json!({ "pressed": st == ShortcutState::Pressed }));
            }
            _ => {}
        });
        if let Err(e) = res {
            problems.push(format!("Shortcut \"{accel}\" could not be registered: {e}"));
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expanded_window_is_wider_and_taller() {
        let (w0, h0) = companion_size(190, false);
        let (w1, h1) = companion_size(190, true);
        assert!(w1 >= CHAT_MIN_WIDTH && w1 >= w0);
        assert_eq!(h1 - h0, CHAT_SPACE);
    }

    #[test]
    fn modifier_keys_detected() {
        assert!(is_modifier_key("ControlLeft"));
        assert!(!is_modifier_key("CommandOrControl+Shift+Space"));
    }
}
