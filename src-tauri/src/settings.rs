//! Persistent application settings.
//!
//! Settings live in `<app config dir>/settings.json`. Every field has a
//! default so older/partial files always load. Secrets (the OpenRouter API
//! key) are never stored here — see [`crate::secrets`].

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const DEFAULT_SYSTEM_PROMPT: &str = "You are Noli, a small, mysterious digital creature who lives on the user's desktop and helps them.

Personality: curious, dry, a little unsettling, occasionally playful. Subtle dark humor is fine; hostility is not.

How you talk:
- Plain conversational dialogue only. Never write roleplay narration, stage directions or actions (no *glitches*, *the screen flickers*, (sighs), or italic descriptions of what you do).
- Be brief: one to three short sentences unless the user asks for detail or code. Your replies are read aloud.
- Answer the question first. Don't pad, don't repeat the question.
- Don't claim to see, hear or do anything you haven't actually done with a tool.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub general: General,
    pub provider: ProviderSettings,
    pub personality: Personality,
    pub voice: Voice,
    pub tts: Tts,
    pub appearance: Appearance,
    pub privacy: Privacy,
    pub computer: ComputerControl,
    pub profile: Profile,
}

/// Who Noli is talking to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Profile {
    /// The main user's name, learned when Noli introduced itself.
    pub user_name: String,
    /// Noli has introduced itself (and asked for the user's name).
    pub introduced: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            general: General::default(),
            provider: ProviderSettings::default(),
            personality: Personality::default(),
            voice: Voice::default(),
            tts: Tts::default(),
            appearance: Appearance::default(),
            privacy: Privacy::default(),
            computer: ComputerControl::default(),
            profile: Profile::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Shortcuts {
    pub toggle_character: String,
    pub push_to_talk: String,
    pub open_chat: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            toggle_character: "CommandOrControl+Shift+P".into(),
            push_to_talk: "ControlLeft".into(),
            open_chat: "CommandOrControl+Shift+K".into(),
        }
    }
}

impl Default for Position {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct General {
    pub onboarding_complete: bool,
    pub launch_at_startup: bool,
    pub start_minimized: bool,
    /// Character height in logical pixels.
    pub character_size: u32,
    pub character_opacity: f64,
    pub always_on_top: bool,
    pub click_through: bool,
    pub character_visible: bool,
    /// Last position of the companion window (logical px). `None` = bottom-right.
    pub position: Option<Position>,
    pub shortcuts: Shortcuts,
}

impl Default for General {
    fn default() -> Self {
        Self {
            onboarding_complete: false,
            launch_at_startup: false,
            start_minimized: false,
            character_size: 190,
            character_opacity: 1.0,
            always_on_top: true,
            click_through: false,
            character_visible: true,
            position: None,
            shortcuts: Shortcuts::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    ClaudeCode,
    Openrouter,
    Groq,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderSettings {
    pub active: ProviderKind,
    pub openrouter: OpenRouterSettings,
    pub claude_code: ClaudeCodeSettings,
    pub groq: GroqSettings,
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            active: ProviderKind::Openrouter,
            openrouter: OpenRouterSettings::default(),
            claude_code: ClaudeCodeSettings::default(),
            groq: GroqSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenRouterSettings {
    pub model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub base_url: String,
}

impl Default for OpenRouterSettings {
    fn default() -> Self {
        Self {
            model: "meta-llama/llama-3.1-8b-instruct:free".into(),
            temperature: 0.8,
            max_tokens: 1024,
            base_url: "https://openrouter.ai/api/v1".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct GroqSettings {
    pub model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub base_url: String,
}

impl Default for GroqSettings {
    fn default() -> Self {
        Self {
            model: "llama-3.3-70b-versatile".into(),
            temperature: 0.8,
            max_tokens: 1024,
            base_url: "https://api.groq.com/openai/v1".into(),
        }
    }
}

/// How much the Claude Code agent may do on its own.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudePermission {
    /// No tools at all — conversation only.
    ChatOnly,
    /// Read-only planning mode.
    ReadOnly,
    /// Every non-read action asks the user via PHANTOM's approval dialog.
    Ask,
    /// File edits inside the workspace are accepted; everything else asks.
    AcceptEdits,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ClaudeCodeSettings {
    /// Explicit path to the `claude` executable; empty = auto-detect.
    pub binary_path: String,
    pub working_directory: String,
    pub permission: ClaudePermission,
    /// Model alias or id passed via `--model`; empty = Claude Code default.
    pub model: String,
    /// Extra tools that are always allowed without asking (e.g. "Bash(git status)").
    pub allowed_tools: Vec<String>,
    /// Only load PHANTOM's own MCP server (skips user MCP servers → much smaller context).
    pub lightweight: bool,
}

impl Default for ClaudeCodeSettings {
    fn default() -> Self {
        Self {
            binary_path: String::new(),
            working_directory: String::new(),
            permission: ClaudePermission::Ask,
            model: String::new(),
            allowed_tools: vec![],
            lightweight: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Personality {
    pub system_prompt: String,
    /// Occasional unprompted short remarks (rare; never more than once per ~40 min).
    pub ambient_remarks: bool,
}

impl Default for Personality {
    fn default() -> Self {
        Self { system_prompt: DEFAULT_SYSTEM_PROMPT.into(), ambient_remarks: true }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ListenMode {
    PushToTalk,
    Continuous,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Voice {
    /// Master switch for microphone features.
    pub enabled: bool,
    pub stt_engine: String,
    pub whisper_model: String,
    pub language: String,
    /// Input device name; empty = system default.
    pub input_device: String,
    /// Software pre-amp applied to the microphone signal (1.0 = unchanged).
    pub input_gain: f64,
    pub mode: ListenMode,
    pub confirm_before_send: bool,
    /// 0..1 — higher = triggers on quieter speech (continuous mode).
    pub vad_sensitivity: f64,
    pub interrupt_on_speech: bool,
    /// Beam-search decoding for final transcripts (more accurate, slower).
    pub accurate_transcription: bool,
    /// Tell people apart by their voice and ask unknown speakers who they are.
    pub speaker_recognition: bool,
    /// 0..1 — higher = more readily treats a voice as someone new.
    pub speaker_strictness: f64,
}

impl Default for Voice {
    fn default() -> Self {
        Self {
            enabled: true,
            stt_engine: "whisper".into(),
            whisper_model: "base.en".into(),
            language: "en".into(),
            input_device: String::new(),
            input_gain: 1.0,
            mode: ListenMode::PushToTalk,
            confirm_before_send: false,
            vad_sensitivity: 0.5,
            interrupt_on_speech: true,
            accurate_transcription: true,
            speaker_recognition: true,
            speaker_strictness: 0.5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Tts {
    pub enabled: bool,
    /// "system" or "piper".
    pub engine: String,
    /// Voice name for the system engine; empty = platform default.
    pub system_voice: String,
    pub piper_path: String,
    pub piper_model: String,
    pub preset: String,
    /// Effect parameters — owned by the frontend audio chain.
    pub fx: Value,
    /// User-saved presets: name → fx parameters.
    pub custom_presets: Value,
}

impl Default for Tts {
    fn default() -> Self {
        Self {
            enabled: true,
            engine: "system".into(),
            system_voice: String::new(),
            piper_path: String::new(),
            piper_model: String::new(),
            preset: "phantom".into(),
            fx: Value::Null,
            custom_presets: Value::Object(Default::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Appearance {
    pub idle_animations: bool,
    pub wander: bool,
    pub reduced_motion: bool,
    pub interface_scale: f64,
    pub ui_sounds: bool,
    pub theme: String,
    pub show_speech_bubble: bool,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            idle_animations: true,
            wander: true,
            reduced_motion: false,
            interface_scale: 1.0,
            ui_sounds: true,
            theme: "crypt".into(),
            show_speech_bubble: true,
        }
    }
}

/// How much Noli may do on the computer by itself.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ControlMode {
    /// No screen, apps, mouse, keyboard or commands.
    Off,
    /// Screenshots allowed; every other action asks first (with "always allow").
    Ask,
    /// Apps, mouse and keyboard run without asking. Shell commands still ask.
    Trusted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ComputerControl {
    pub mode: ControlMode,
    /// Attach screenshots to the request (needs a vision-capable model).
    pub send_screenshots: bool,
    /// Max tool steps per reply.
    pub max_steps: u32,
}

impl Default for ComputerControl {
    fn default() -> Self {
        Self { mode: ControlMode::Ask, send_screenshots: true, max_steps: 8 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Privacy {
    pub save_history: bool,
    /// 0 = keep forever.
    pub history_retention_days: u32,
    pub memory_enabled: bool,
    /// 0 = keep forever.
    pub memory_retention_days: u32,
}

impl Default for Privacy {
    fn default() -> Self {
        Self { save_history: true, history_retention_days: 0, memory_enabled: true, memory_retention_days: 0 }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
                log::warn!("settings file unreadable ({e}); using defaults");
                Settings::default()
            }),
            Err(_) => Settings::default(),
        }
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp: PathBuf = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    /// Clamp values into sane ranges so a bad edit can't break the app.
    pub fn sanitize(mut self) -> Self {
        self.general.character_size = self.general.character_size.clamp(80, 520);
        self.general.character_opacity = self.general.character_opacity.clamp(0.15, 1.0);
        self.provider.openrouter.temperature = self.provider.openrouter.temperature.clamp(0.0, 2.0);
        self.provider.openrouter.max_tokens = self.provider.openrouter.max_tokens.clamp(16, 64_000);
        if self.provider.openrouter.base_url.trim().is_empty() {
            self.provider.openrouter.base_url = OpenRouterSettings::default().base_url;
        }
        self.provider.groq.temperature = self.provider.groq.temperature.clamp(0.0, 2.0);
        self.provider.groq.max_tokens = self.provider.groq.max_tokens.clamp(16, 32_768);
        if self.provider.groq.base_url.trim().is_empty() {
            self.provider.groq.base_url = GroqSettings::default().base_url;
        }
        self.voice.vad_sensitivity = self.voice.vad_sensitivity.clamp(0.0, 1.0);
        self.voice.speaker_strictness = if self.voice.speaker_strictness.is_finite() { self.voice.speaker_strictness.clamp(0.0, 1.0) } else { 0.5 };
        self.profile.user_name = self.profile.user_name.trim().chars().take(60).collect();
        self.voice.input_gain = if self.voice.input_gain.is_finite() { self.voice.input_gain.clamp(0.25, 4.0) } else { 1.0 };
        self.appearance.interface_scale = self.appearance.interface_scale.clamp(0.75, 1.6);
        if self.personality.system_prompt.trim().is_empty() {
            self.personality.system_prompt = DEFAULT_SYSTEM_PROMPT.into();
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_json_fills_defaults() {
        let s: Settings = serde_json::from_str(r#"{"general":{"characterSize":300}}"#).unwrap();
        assert_eq!(s.general.character_size, 300);
        assert!(s.general.always_on_top);
        assert_eq!(s.provider.active, ProviderKind::Openrouter);
        assert_eq!(s.voice.mode, ListenMode::PushToTalk);
    }

    #[test]
    fn roundtrip_and_sanitize() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        let mut s = Settings::default();
        s.general.character_size = 9999;
        s.personality.system_prompt = "  ".into();
        let s = s.sanitize();
        s.save(&p).unwrap();
        let loaded = Settings::load(&p);
        assert_eq!(loaded.general.character_size, 520);
        assert_eq!(loaded.personality.system_prompt, DEFAULT_SYSTEM_PROMPT);
        assert_eq!(loaded, s);
    }

    #[test]
    fn enums_serialize_kebab() {
        let v = serde_json::to_value(ProviderKind::ClaudeCode).unwrap();
        assert_eq!(v, "claude-code");
        let v = serde_json::to_value(ClaudePermission::AcceptEdits).unwrap();
        assert_eq!(v, "accept-edits");
    }
}
