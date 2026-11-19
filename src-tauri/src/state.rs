//! Shared application state.

use crate::permission::PermissionBridge;
use crate::providers::groq::GroqModelInfo;
use crate::providers::openrouter::ModelInfo;
use crate::providers::ProviderContext;
use crate::settings::Settings;
use crate::storage::Storage;
use crate::voice::VoiceManager;
use parking_lot::{Mutex, RwLock};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

pub type CmdResult<T> = Result<T, String>;

/// Converts any error into the string sent to the frontend (full context chain).
pub fn err(e: impl Into<anyhow::Error>) -> String {
    format!("{:#}", e.into())
}

pub struct AppState {
    pub settings: RwLock<Settings>,
    pub settings_path: PathBuf,
    pub storage: Arc<Storage>,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub default_workspace: PathBuf,
    pub http: reqwest::Client,
    /// Running generations by conversation id.
    pub generations: Mutex<HashMap<String, CancellationToken>>,
    pub active_conversation: Mutex<Option<String>>,
    pub voice: Arc<VoiceManager>,
    pub permissions: Option<Arc<PermissionBridge>>,
    /// PATH from the user's login shell (GUI apps on macOS start with a minimal PATH).
    pub env_path: Option<String>,
    pub models_cache: Mutex<Option<(Instant, Vec<ModelInfo>)>>,
    pub groq_models_cache: Mutex<Option<(Instant, Vec<GroqModelInfo>)>>,
}

impl AppState {
    pub fn provider_context(&self) -> ProviderContext {
        ProviderContext {
            http: self.http.clone(),
            env_path: self.env_path.clone(),
            default_workspace: self.default_workspace.clone(),
            permission_bridge: self.permissions.as_ref().map(|p| p.info.clone()),
        }
    }
}

/// Reads PATH from the user's login shell so Node-based CLIs (claude, piper…)
/// can be found and run when PHANTOM is launched from Finder/Explorer.
pub fn login_shell_path() -> Option<String> {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let out = std::process::Command::new(shell)
                .args(["-l", "-c", "printf '__PHANTOM_PATH__%s__END__' \"$PATH\""])
                .stdin(std::process::Stdio::null())
                .output();
            let _ = tx.send(out);
        });
        let out = rx.recv_timeout(std::time::Duration::from_secs(4)).ok()?.ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        let start = s.find("__PHANTOM_PATH__")? + "__PHANTOM_PATH__".len();
        let end = s[start..].find("__END__")? + start;
        let shell_path = &s[start..end];
        let current = std::env::var("PATH").unwrap_or_default();
        let mut parts: Vec<&str> = shell_path.split(':').collect();
        for p in current.split(':') {
            if !parts.contains(&p) {
                parts.push(p);
            }
        }
        Some(parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(":"))
    }
    #[cfg(not(unix))]
    {
        std::env::var("PATH").ok()
    }
}
