//! PHANTOM — a horror-themed desktop AI companion.
//!
//! Backend layout:
//! * `settings` / `storage` / `secrets` — persistence (JSON, SQLite, OS keychain)
//! * `providers` — Claude Code + OpenRouter behind one interface
//! * `chat` — conversation orchestration + streaming events
//! * `permission` — approval bridge for Claude Code tool use
//! * `voice` — microphone + local Whisper speech recognition
//! * `tts` — speech synthesis (system voices / Piper)
//! * `windows` — companion window, chat/settings windows, tray, shortcuts

mod agent;
mod chat;
mod commands;
mod modifier_key;
mod permission;
mod providers;
mod secrets;
mod settings;
mod state;
mod storage;
mod tts;
pub mod system_tools;
mod voice;
mod windows;

use parking_lot::{Mutex, RwLock};
use settings::Settings;
use state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

static COMPANION_SHOWN_ONCE: AtomicBool = AtomicBool::new(false);

/// Called by the companion window once its sprites are loaded, so it never
/// flashes an empty transparent frame. Honors "start minimized" on launch.
#[tauri::command]
fn companion_ready(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    let s = state.settings.read().clone();
    let first = !COMPANION_SHOWN_ONCE.swap(true, Ordering::SeqCst);
    let launched_by_autostart = std::env::args().any(|a| a == "--autostart");
    let hide_on_launch = first && (s.general.start_minimized || (launched_by_autostart && s.general.start_minimized));
    // On first run Noli waits until setup is finished, then arrives (see settings_update).
    if s.general.character_visible && !hide_on_launch && s.general.onboarding_complete {
        if let Some(w) = app.get_webview_window(windows::COMPANION) {
            let _ = w.show();
            let _ = app.emit_to(windows::COMPANION, "companion://shown", ());
        }
    }
}

pub use system_tools::{probe_screen_permission, SCREEN_PROBE_ARG};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // launching PHANTOM again: `--settings[=section]` opens settings, otherwise the chatbox
            match args.iter().find_map(|a| a.strip_prefix("--settings")) {
                Some(rest) => windows::show_settings(app, rest.strip_prefix('=').map(str::to_string)),
                None => windows::open_chatbox(app, false),
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = app.path();
            let config_dir = paths.app_config_dir()?;
            let data_dir = paths.app_data_dir()?;
            let cache_dir = paths.app_cache_dir()?;
            let default_workspace = paths.document_dir().unwrap_or_else(|_| data_dir.clone()).join("PHANTOM Workspace");
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&cache_dir)?;

            let settings_path = config_dir.join("settings.json");
            let settings = Settings::load(&settings_path).sanitize();
            let storage = Arc::new(storage::Storage::open(&data_dir.join("phantom.db"))?);
            let _ = storage.recover_interrupted();
            if !settings.privacy.save_history {
                let _ = storage.delete_all_conversations();
            }
            let _ = storage.apply_retention(settings.privacy.history_retention_days, settings.privacy.memory_retention_days);
            // leftover TTS temp files from a crash
            let _ = std::fs::remove_dir_all(cache_dir.join("tts"));

            let http = reqwest::Client::builder()
                .user_agent(concat!("PHANTOM/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(15))
                .build()?;
            let permissions = match permission::PermissionBridge::start(handle.clone()) {
                Ok(p) => Some(p),
                Err(e) => {
                    log::error!("permission bridge unavailable: {e:#}");
                    None
                }
            };
            app.manage(AppState {
                settings: RwLock::new(settings.clone()),
                settings_path,
                storage,
                data_dir: data_dir.clone(),
                cache_dir,
                default_workspace,
                http,
                generations: Mutex::new(Default::default()),
                active_conversation: Mutex::new(None),
                voice: Arc::new(voice::VoiceManager::new(data_dir.join("models"))),
                permissions,
                env_path: state::login_shell_path(),
                models_cache: Mutex::new(None),
                groq_models_cache: Mutex::new(None),
            });

            windows::build_tray(&handle, &settings)?;
            for p in windows::register_shortcuts(&handle, &settings) {
                log::warn!("{p}");
            }
            windows::create_companion(&handle, &settings)?;

            // keep the OS login item in sync with the setting
            let al = handle.autolaunch();
            if al.is_enabled().unwrap_or(false) != settings.general.launch_at_startup {
                let _ = if settings.general.launch_at_startup { al.enable() } else { al.disable() };
            }
            if !settings.general.onboarding_complete {
                windows::show_settings(&handle, Some("onboarding".into()));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Windows hide instead of closing; PHANTOM keeps living in the tray.
                api.prevent_close();
                let _ = window.hide();
                if window.label() == windows::COMPANION {
                    windows::set_companion_visible(window.app_handle(), false);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            companion_ready,
            commands::settings_get,
            commands::settings_update,
            commands::settings_reset,
            commands::conversations_list,
            commands::conversation_get,
            commands::conversation_create,
            commands::conversation_rename,
            commands::conversation_delete,
            commands::conversation_clear,
            commands::conversations_delete_all,
            commands::conversation_export,
            commands::memories_list,
            commands::memory_add,
            commands::memory_update,
            commands::memory_delete,
            commands::memories_clear,
            commands::claude_status,
            commands::claude_workspace,
            commands::openrouter_key_status,
            commands::openrouter_set_key,
            commands::openrouter_delete_key,
            commands::openrouter_test,
            commands::openrouter_models,
            commands::groq_key_status,
            commands::groq_set_key,
            commands::groq_delete_key,
            commands::groq_test,
            commands::groq_models,
            commands::permission_respond,
            commands::permission_pending,
            commands::app_info,
            commands::open_window,
            commands::companion_toggle,
            commands::companion_set_visible,
            commands::companion_save_position,
            commands::companion_set_expanded,
            commands::show_menu,
            commands::quit_app,
            commands::reveal_data_dir,
            commands::computer_permissions,
            commands::computer_open_permission,
            commands::app_restart,
            commands::computer_repair_permission,
            chat::chat_send,
            chat::chat_cancel,
            chat::chat_cancel_all,
            chat::chat_regenerate,
            chat::chat_set_active,
            chat::chat_get_active,
            chat::chat_running,
            voice::voice_devices,
            voice::voice_models,
            voice::voice_download_model,
            voice::voice_delete_model,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_cancel,
            voice::voice_set_speaking,
            voice::voice_status,
            voice::voice_transcribe_file,
            voice::speakers_list,
            voice::speaker_enroll,
            voice::speaker_rename,
            voice::speaker_set_owner,
            voice::speaker_delete,
            voice::speakers_clear,
            tts::tts_status,
            tts::tts_list_voices,
            tts::tts_synthesize,
            tts::tts_piper_voices,
            tts::tts_download_piper_voice,
        ])
        .build(tauri::generate_context!())
        .expect("error while building PHANTOM")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                // Closing the last window keeps PHANTOM in the tray; only explicit quit exits.
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
