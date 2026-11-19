//! Voice input: microphone capture, voice-activity detection and local
//! Whisper transcription. Push-to-talk and continuous listening are both
//! driven from here; the frontend only starts/stops and renders events.

pub mod capture;
pub mod stt;

use crate::settings::ListenMode;
use crate::state::{err, AppState, CmdResult};
use capture::{Capture, CaptureShared};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct VoiceManager {
    pub stt: stt::Stt,
    pub models_dir: PathBuf,
    session: Mutex<Option<Session>>,
    /// True while PHANTOM's own TTS is playing (prevents hearing itself).
    pub speaking: Arc<AtomicBool>,
    session_counter: AtomicU64,
    downloading: Mutex<std::collections::HashSet<String>>,
}

struct Session {
    capture: Capture,
    mode: ListenMode,
    done: Arc<AtomicBool>,
    monitor: Option<std::thread::JoinHandle<()>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceStateEvent {
    listening: bool,
    mode: Option<ListenMode>,
    phase: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEvent {
    pub text: String,
    /// true when produced by continuous listening (not a manual stop).
    pub auto: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelProgress {
    name: String,
    received: u64,
    total: Option<u64>,
    done: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    name: String,
    size_mb: u32,
    description: String,
    downloaded: bool,
    downloading: bool,
}

struct ListenParams {
    language: String,
    model: String,
    sensitivity: f32,
    interrupt: bool,
}

impl VoiceManager {
    pub fn new(models_dir: PathBuf) -> Self {
        Self {
            stt: stt::Stt::new(),
            models_dir,
            session: Mutex::new(None),
            speaking: Arc::new(AtomicBool::new(false)),
            session_counter: AtomicU64::new(0),
            downloading: Mutex::new(Default::default()),
        }
    }

    fn stop_session(&self) -> Option<(Arc<CaptureShared>, ListenMode)> {
        let s = self.session.lock().take()?;
        s.done.store(true, Ordering::Relaxed);
        let shared = s.capture.stop();
        if let Some(m) = s.monitor {
            let _ = m.join();
        }
        Some((shared, s.mode))
    }
}

fn emit_state(app: &AppHandle, listening: bool, mode: Option<ListenMode>, phase: &'static str) {
    let _ = app.emit("voice://state", VoiceStateEvent { listening, mode, phase });
}

fn transcribe_samples(app: &AppHandle, samples: &[f32], rate: u32, p: &ListenParams) -> anyhow::Result<String> {
    let st = app.state::<AppState>();
    let ctx = st.voice.stt.context(&st.voice.models_dir, &p.model)?;
    let audio = capture::resample_to_16k(samples, rate);
    if capture::rms(&audio) < 0.002 {
        return Ok(String::new());
    }
    stt::transcribe(&ctx, &audio, &p.language)
}

/// Background loop: level meter, live partial transcripts (push-to-talk) and
/// voice-activity detection (continuous).
fn monitor_loop(app: AppHandle, shared: Arc<CaptureShared>, mode: ListenMode, done: Arc<AtomicBool>, speaking: Arc<AtomicBool>, p: ListenParams) {
    let p = Arc::new(p);
    let tick = Duration::from_millis(50);
    let mut last_level_emit = Instant::now();
    let mut last_partial = Instant::now();
    let mut partial_len = 0usize;
    let partial_busy = Arc::new(AtomicBool::new(false));
    // VAD
    let threshold = 0.045 * (1.0 - p.sensitivity) + 0.006;
    let barge_threshold = (threshold * 4.0).max(0.09);
    let mut processed = 0usize;
    let mut above = 0u32;
    let mut below = 0u32;
    let mut in_speech = false;
    let mut speech_start = 0usize;
    let mut barge = 0u32;

    while !done.load(Ordering::Relaxed) {
        std::thread::sleep(tick);
        if let Some(e) = shared.failed.lock().take() {
            let _ = app.emit("voice://error", format!("Microphone error: {e}"));
        }
        let rate = shared.sample_rate.load(Ordering::Relaxed).max(8000) as usize;
        let level = shared.level();
        if last_level_emit.elapsed() >= Duration::from_millis(60) {
            last_level_emit = Instant::now();
            let _ = app.emit("voice://level", (level * 9.0).min(1.0));
        }

        match mode {
            ListenMode::PushToTalk => {
                let len = shared.samples.lock().len();
                if last_partial.elapsed() >= Duration::from_millis(1100)
                    && len.saturating_sub(partial_len) > rate / 2
                    && !partial_busy.load(Ordering::Relaxed)
                {
                    last_partial = Instant::now();
                    partial_len = len;
                    let snapshot: Vec<f32> = {
                        let s = shared.samples.lock();
                        let from = s.len().saturating_sub(rate * 28);
                        s[from..].to_vec()
                    };
                    let (app2, busy, p2) = (app.clone(), partial_busy.clone(), p.clone());
                    busy.store(true, Ordering::Relaxed);
                    let done2 = done.clone();
                    std::thread::spawn(move || {
                        if let Ok(text) = transcribe_samples(&app2, &snapshot, rate as u32, &p2) {
                            if !done2.load(Ordering::Relaxed) && !text.is_empty() {
                                let _ = app2.emit("voice://partial", TranscriptEvent { text, auto: false });
                            }
                        }
                        busy.store(false, Ordering::Relaxed);
                    });
                }
            }
            ListenMode::Continuous => {
                let block = rate / 20; // 50 ms
                let mut samples = shared.samples.lock();
                while processed + block <= samples.len() {
                    let lvl = capture::rms(&samples[processed..processed + block]);
                    processed += block;
                    let is_speaking = speaking.load(Ordering::Relaxed);
                    if !in_speech {
                        if is_speaking {
                            // While PHANTOM talks, only a clearly louder voice barges in.
                            if p.interrupt && lvl > barge_threshold {
                                barge += 1;
                                if barge >= 6 {
                                    barge = 0;
                                    let _ = app.emit("voice://barge-in", ());
                                    in_speech = true;
                                    speech_start = processed.saturating_sub(rate / 2);
                                    above = 0;
                                    below = 0;
                                }
                            } else {
                                barge = 0;
                            }
                            continue;
                        }
                        if lvl > threshold {
                            above += 1;
                            if above >= 3 {
                                in_speech = true;
                                below = 0;
                                speech_start = processed.saturating_sub(rate * 2 / 5);
                                emit_state(&app, true, Some(mode), "speech");
                            }
                        } else {
                            above = 0;
                        }
                    } else {
                        if lvl < threshold * 0.7 {
                            below += 1;
                        } else {
                            below = 0;
                        }
                        let too_long = processed - speech_start > rate * 28;
                        if below >= 18 || too_long {
                            in_speech = false;
                            above = 0;
                            let segment = samples[speech_start..processed].to_vec();
                            let (app2, p2) = (app.clone(), p.clone());
                            emit_state(&app, true, Some(mode), "transcribing");
                            std::thread::spawn(move || {
                                match transcribe_samples(&app2, &segment, rate as u32, &p2) {
                                    Ok(text) if !text.is_empty() => {
                                        let _ = app2.emit("voice://final", TranscriptEvent { text, auto: true });
                                    }
                                    Ok(_) => {}
                                    Err(e) => {
                                        let _ = app2.emit("voice://error", format!("{e:#}"));
                                    }
                                }
                                emit_state(&app2, true, Some(ListenMode::Continuous), "idle");
                            });
                        }
                    }
                }
                // keep memory bounded while waiting for speech
                if !in_speech && samples.len() > rate * 4 {
                    let drop_n = samples.len() - rate;
                    samples.drain(..drop_n);
                    processed = processed.saturating_sub(drop_n);
                }
            }
        }
    }
}

fn listen_params(state: &AppState) -> ListenParams {
    let s = state.settings.read();
    ListenParams {
        language: s.voice.language.clone(),
        model: s.voice.whisper_model.clone(),
        sensitivity: s.voice.vad_sensitivity as f32,
        interrupt: s.voice.interrupt_on_speech,
    }
}

#[tauri::command]
pub fn voice_devices() -> CmdResult<Vec<capture::InputDevice>> {
    capture::list_input_devices().map_err(err)
}

#[tauri::command]
pub fn voice_models(state: State<'_, AppState>) -> Vec<ModelEntry> {
    let downloading = state.voice.downloading.lock().clone();
    stt::MODELS
        .iter()
        .map(|m| ModelEntry {
            name: m.name.into(),
            size_mb: m.size_mb,
            description: m.description.into(),
            downloaded: stt::model_path(&state.voice.models_dir, m.name).exists(),
            downloading: downloading.contains(m.name),
        })
        .collect()
}

#[tauri::command]
pub async fn voice_download_model(app: AppHandle, state: State<'_, AppState>, name: String) -> CmdResult<()> {
    if !stt::is_known_model(&name) {
        return Err(format!("unknown model {name}"));
    }
    if !state.voice.downloading.lock().insert(name.clone()) {
        return Err("already downloading".into());
    }
    let dir = state.voice.models_dir.clone();
    let client = state.http.clone();
    let app2 = app.clone();
    let n2 = name.clone();
    let result = stt::download_model(&client, &dir, &name, move |received, total| {
        let _ = app2.emit("voice://model-progress", ModelProgress { name: n2.clone(), received, total, done: false, error: None });
    })
    .await;
    state.voice.downloading.lock().remove(&name);
    match result {
        Ok(_) => {
            let _ = app.emit("voice://model-progress", ModelProgress { name, received: 0, total: None, done: true, error: None });
            Ok(())
        }
        Err(e) => {
            let msg = format!("{e:#}");
            let _ = app.emit("voice://model-progress", ModelProgress { name, received: 0, total: None, done: true, error: Some(msg.clone()) });
            Err(msg)
        }
    }
}

#[tauri::command]
pub fn voice_delete_model(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    if !stt::is_known_model(&name) {
        return Err("unknown model".into());
    }
    state.voice.stt.unload();
    let p = stt::model_path(&state.voice.models_dir, &name);
    if p.exists() {
        std::fs::remove_file(p).map_err(err)?;
    }
    Ok(())
}

/// Starts listening. `mode` defaults to the configured listening mode.
#[tauri::command]
pub async fn voice_start(app: AppHandle, state: State<'_, AppState>, mode: Option<ListenMode>) -> CmdResult<()> {
    let (enabled, device, cfg_mode, gain) = {
        let s = state.settings.read();
        (s.voice.enabled, s.voice.input_device.clone(), s.voice.mode, s.voice.input_gain as f32)
    };
    if !enabled {
        return Err("Voice input is disabled in Settings → Privacy.".into());
    }
    let mode = mode.unwrap_or(cfg_mode);
    if let Some(cur) = state.voice.session.lock().as_ref() {
        if cur.mode == mode {
            return Ok(());
        }
    }
    state.voice.stop_session();
    let params = listen_params(&state);
    // Load the model first so a missing model fails before the mic opens.
    {
        let voice = app.state::<AppState>().voice.clone();
        let model = params.model.clone();
        tauri::async_runtime::spawn_blocking(move || voice.stt.context(&voice.models_dir, &model).map(|_| ()))
            .await
            .map_err(err)?
            .map_err(err)?;
    }
    let capture = Capture::start(&device, gain).map_err(err)?;
    let done = Arc::new(AtomicBool::new(false));
    let shared = capture.shared.clone();
    let app2 = app.clone();
    let done2 = done.clone();
    let speaking = state.voice.speaking.clone();
    state.voice.session_counter.fetch_add(1, Ordering::Relaxed);
    let monitor = std::thread::Builder::new()
        .name("phantom-voice-monitor".into())
        .spawn(move || monitor_loop(app2, shared, mode, done2, speaking, params))
        .map_err(err)?;
    *state.voice.session.lock() = Some(Session { capture, mode, done, monitor: Some(monitor) });
    emit_state(&app, true, Some(mode), "idle");
    Ok(())
}

/// Stops listening. In push-to-talk mode the whole recording is transcribed
/// and returned (and emitted as `voice://final`).
#[tauri::command]
pub async fn voice_stop(app: AppHandle, state: State<'_, AppState>) -> CmdResult<TranscriptEvent> {
    let Some((shared, mode)) = state.voice.stop_session() else {
        emit_state(&app, false, None, "idle");
        return Ok(TranscriptEvent { text: String::new(), auto: false });
    };
    if mode == ListenMode::Continuous {
        emit_state(&app, false, None, "idle");
        return Ok(TranscriptEvent { text: String::new(), auto: true });
    }
    emit_state(&app, false, Some(mode), "transcribing");
    let params = listen_params(&state);
    let rate = shared.sample_rate.load(Ordering::Relaxed);
    let samples = std::mem::take(&mut *shared.samples.lock());
    let app2 = app.clone();
    let text = tauri::async_runtime::spawn_blocking(move || transcribe_samples(&app2, &samples, rate, &params))
        .await
        .map_err(err)?
        .map_err(err)?;
    emit_state(&app, false, None, "idle");
    let ev = TranscriptEvent { text, auto: false };
    let _ = app.emit("voice://final", ev.clone());
    Ok(ev)
}

#[tauri::command]
pub fn voice_cancel(app: AppHandle, state: State<'_, AppState>) {
    state.voice.stop_session();
    emit_state(&app, false, None, "idle");
}

#[tauri::command]
pub fn voice_set_speaking(state: State<'_, AppState>, speaking: bool) {
    state.voice.speaking.store(speaking, Ordering::Relaxed);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    listening: bool,
    mode: Option<ListenMode>,
}

#[tauri::command]
pub fn voice_status(state: State<'_, AppState>) -> VoiceStatus {
    let s = state.voice.session.lock();
    VoiceStatus { listening: s.is_some(), mode: s.as_ref().map(|s| s.mode) }
}

/// Transcribes a WAV file (used by tests and the "test microphone" flow).
#[tauri::command]
pub async fn voice_transcribe_file(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<String> {
    let params = listen_params(&state);
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<String> {
        let mut reader = hound::WavReader::open(&path)?;
        let spec = reader.spec();
        let ch = spec.channels as usize;
        let raw: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => reader.samples::<f32>().filter_map(Result::ok).collect(),
            hound::SampleFormat::Int => {
                let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
                reader.samples::<i32>().filter_map(Result::ok).map(|v| v as f32 / max).collect()
            }
        };
        let mono: Vec<f32> = raw.chunks(ch.max(1)).map(|c| c.iter().sum::<f32>() / c.len() as f32).collect();
        transcribe_samples(&app, &mono, spec.sample_rate, &params)
    })
    .await
    .map_err(err)?
    .map_err(err)
}
