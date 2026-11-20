//! Voice input: microphone capture, voice-activity detection and local
//! Whisper transcription. Push-to-talk and continuous listening are both
//! driven from here; the frontend only starts/stops and renders events.

pub mod capture;
pub mod speaker;
pub mod stt;

use crate::settings::ListenMode;
use crate::state::{err, AppState, CmdResult};
use capture::{Capture, CaptureShared};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::collections::VecDeque;
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
    /// Voiceprints of recent utterances, so the UI can later say "that was Ada".
    recent_prints: Mutex<VecDeque<(String, speaker::Voiceprint)>>,
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
    /// Who said it, when speaker recognition is on (final transcripts only).
    pub speaker: Option<SpeakerInfo>,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerInfo {
    /// known | likely | unknown | new (nobody enrolled yet) | unclear (too little speech)
    pub status: &'static str,
    pub id: Option<String>,
    pub name: Option<String>,
    pub is_owner: bool,
    /// Pass to `speaker_enroll` to learn this utterance's voice under a name.
    pub token: Option<String>,
    pub distance: Option<f32>,
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

#[derive(Clone)]
struct ListenParams {
    language: String,
    model: String,
    sensitivity: f32,
    interrupt: bool,
    accurate: bool,
    vocabulary: Vec<String>,
    speaker_recognition: bool,
    strictness: f32,
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
            recent_prints: Mutex::new(VecDeque::new()),
        }
    }

    fn remember_print(&self, print: speaker::Voiceprint) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        let mut q = self.recent_prints.lock();
        q.push_back((token.clone(), print));
        while q.len() > 12 {
            q.pop_front();
        }
        token
    }

    fn take_print(&self, token: &str) -> Option<speaker::Voiceprint> {
        let mut q = self.recent_prints.lock();
        let i = q.iter().position(|(t, _)| t == token)?;
        q.remove(i).map(|(_, p)| p)
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

/// Resamples, cleans and transcribes. `final_pass` uses the accurate decoder;
/// live previews stay greedy and fast. Returns the text and the prepared audio.
fn transcribe_samples(app: &AppHandle, samples: &[f32], rate: u32, p: &ListenParams, final_pass: bool) -> anyhow::Result<(String, Vec<f32>)> {
    let st = app.state::<AppState>();
    let ctx = st.voice.stt.context(&st.voice.models_dir, &p.model)?;
    let raw = capture::resample_to_16k(samples, rate);
    // nothing louder than a whisper anywhere: don't let Whisper imagine words
    let loudest = raw.chunks(320).map(capture::rms).fold(0.0f32, f32::max);
    if loudest < 0.004 {
        return Ok((String::new(), vec![]));
    }
    let audio = capture::prepare_for_stt(&raw);
    let opts = stt::DecodeOptions { language: p.language.clone(), accurate: final_pass && p.accurate, vocabulary: p.vocabulary.clone(), model: p.model.clone() };
    let text = stt::transcribe(&ctx, &audio, &opts)?;
    Ok((text, audio))
}

/// Final transcript of an utterance, plus who said it.
fn finish_utterance(app: &AppHandle, samples: &[f32], rate: u32, p: &ListenParams, auto: bool) -> anyhow::Result<TranscriptEvent> {
    let (text, audio) = transcribe_samples(app, samples, rate, p, true)?;
    let speaker = (p.speaker_recognition && !text.is_empty()).then(|| identify(app, &audio, p.strictness));
    Ok(TranscriptEvent { text, auto, speaker })
}

/// Matches an utterance against the people Noli knows, learning from clear matches.
fn identify(app: &AppHandle, audio: &[f32], strictness: f32) -> SpeakerInfo {
    let unclear = SpeakerInfo { status: "unclear", id: None, name: None, is_owner: false, token: None, distance: None };
    let Some(print) = speaker::extract(audio) else { return unclear };
    let st = app.state::<AppState>();
    let token = Some(st.voice.remember_print(print.clone()));
    let known: Vec<(crate::storage::Speaker, speaker::Voiceprint)> =
        st.storage.speakers().unwrap_or_default().into_iter().filter_map(|s| serde_json::from_str(&s.print).ok().map(|p| (s, p))).collect();
    if known.is_empty() {
        return SpeakerInfo { status: "new", token, ..unclear };
    }
    let base = speaker::base_threshold(strictness);
    let best = known
        .into_iter()
        .map(|(s, p)| {
            let d = speaker::distance(&print, &p);
            let t = p.threshold(base);
            (s, p, d, t)
        })
        .min_by(|a, b| (a.2 / a.3).partial_cmp(&(b.2 / b.3)).unwrap_or(std::cmp::Ordering::Equal));
    let Some((sp, mut profile, d, t)) = best else { return unclear };
    let verdict = speaker::verdict(d, t);
    if verdict != speaker::Verdict::Unknown {
        // learn: clear matches refine the voiceprint; every plausible match
        // teaches how much this person's voice varies
        profile.observe_self_distance(d);
        let learn = verdict == speaker::Verdict::Match;
        if learn {
            profile.merge(&print);
        }
        if let Ok(json) = serde_json::to_string(&profile) {
            let _ = st.storage.update_speaker_print(&sp.id, &json, learn);
        }
    }
    let status = match verdict {
        speaker::Verdict::Match => "known",
        speaker::Verdict::Likely => "likely",
        speaker::Verdict::Unknown => "unknown",
    };
    log::info!("speaker: {status} (closest {} at {d:.2}, threshold {t:.2})", sp.name);
    let named = verdict != speaker::Verdict::Unknown;
    SpeakerInfo {
        status,
        id: named.then(|| sp.id.clone()),
        name: named.then(|| sp.name.clone()),
        is_owner: named && sp.is_owner,
        token,
        distance: Some(d),
    }
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
    // VAD: the threshold follows the room's background noise, so a noisy
    // room doesn't trigger constantly and a quiet one still hears soft voices.
    let abs_min = 0.004 + 0.03 * (1.0 - p.sensitivity);
    let noise_mult = 2.5 + 3.0 * (1.0 - p.sensitivity);
    let mut noise = abs_min / noise_mult;
    let mut voiced = 0u32;
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
                        if let Ok((text, _)) = transcribe_samples(&app2, &snapshot, rate as u32, &p2, false) {
                            if !done2.load(Ordering::Relaxed) && !text.is_empty() {
                                let _ = app2.emit("voice://partial", TranscriptEvent { text, auto: false, speaker: None });
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
                    if !in_speech {
                        // falls quickly, rises slowly: speech bursts barely move it
                        noise = if lvl < noise { noise * 0.8 + lvl * 0.2 } else { noise * 0.995 + lvl * 0.005 };
                    }
                    let threshold = (noise * noise_mult).max(abs_min);
                    let barge_threshold = (threshold * 4.0).max(0.09);
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
                                    voiced = 6;
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
                                voiced = 3;
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
                        if lvl > threshold {
                            voiced += 1;
                        }
                        let too_long = processed - speech_start > rate * 28;
                        if below >= 16 || too_long {
                            in_speech = false;
                            above = 0;
                            // a door slam or a key click is not a sentence: need ~300 ms of voice
                            if voiced < 6 {
                                emit_state(&app, true, Some(mode), "idle");
                                continue;
                            }
                            let segment = samples[speech_start..processed].to_vec();
                            let (app2, p2) = (app.clone(), p.clone());
                            emit_state(&app, true, Some(mode), "transcribing");
                            std::thread::spawn(move || {
                                match finish_utterance(&app2, &segment, rate as u32, &p2, true) {
                                    Ok(ev) if !ev.text.is_empty() => {
                                        let _ = app2.emit("voice://final", ev);
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
    let s = state.settings.read().clone();
    // names Noli should expect to hear, so Whisper spells them right
    let mut vocabulary: Vec<String> = vec![];
    if !s.profile.user_name.trim().is_empty() {
        vocabulary.push(s.profile.user_name.clone());
    }
    vocabulary.extend(state.storage.speakers().unwrap_or_default().into_iter().map(|sp| sp.name));
    ListenParams {
        language: s.voice.language.clone(),
        model: s.voice.whisper_model.clone(),
        sensitivity: s.voice.vad_sensitivity as f32,
        interrupt: s.voice.interrupt_on_speech,
        accurate: s.voice.accurate_transcription,
        vocabulary,
        speaker_recognition: s.voice.speaker_recognition && s.privacy.memory_enabled,
        strictness: s.voice.speaker_strictness as f32,
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
    // People let go of the key on their last syllable: keep recording a moment longer.
    let ptt = state.voice.session.lock().as_ref().map(|s| s.mode) == Some(ListenMode::PushToTalk);
    if ptt {
        tokio::time::sleep(Duration::from_millis(220)).await;
    }
    let Some((shared, mode)) = state.voice.stop_session() else {
        emit_state(&app, false, None, "idle");
        return Ok(TranscriptEvent { text: String::new(), auto: false, speaker: None });
    };
    if mode == ListenMode::Continuous {
        emit_state(&app, false, None, "idle");
        return Ok(TranscriptEvent { text: String::new(), auto: true, speaker: None });
    }
    emit_state(&app, false, Some(mode), "transcribing");
    let params = listen_params(&state);
    let rate = shared.sample_rate.load(Ordering::Relaxed);
    let samples = std::mem::take(&mut *shared.samples.lock());
    let app2 = app.clone();
    let ev = tauri::async_runtime::spawn_blocking(move || finish_utterance(&app2, &samples, rate, &params, false))
        .await
        .map_err(err)?
        .map_err(err)?;
    emit_state(&app, false, None, "idle");
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
        transcribe_samples(&app, &mono, spec.sample_rate, &params, true).map(|(t, _)| t)
    })
    .await
    .map_err(err)?
    .map_err(err)
}

// ---- known voices -----------------------------------------------------------------

#[tauri::command]
pub fn speakers_list(state: State<'_, AppState>) -> CmdResult<Vec<crate::storage::Speaker>> {
    state.storage.speakers().map_err(err)
}

/// Learns the voice of a recent utterance (`token` from a transcript) under
/// `name`. An existing person with that name is refined rather than duplicated.
#[tauri::command]
pub fn speaker_enroll(app: AppHandle, state: State<'_, AppState>, token: String, name: String, is_owner: bool) -> CmdResult<crate::storage::Speaker> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("A name is needed.".into());
    }
    let print = state.voice.take_print(&token).ok_or("That voice sample has expired — say something again.")?;
    let storage = &state.storage;
    let result = match storage.speaker_by_name(&name).map_err(err)? {
        Some(existing) => {
            let mut profile: speaker::Voiceprint = serde_json::from_str(&existing.print).unwrap_or_else(|_| print.clone());
            // the user just told us this is them: a valuable "how different can they sound" sample
            profile.observe_self_distance(speaker::distance(&print, &profile));
            profile.merge(&print);
            storage.update_speaker_print(&existing.id, &serde_json::to_string(&profile).map_err(err)?, true).map_err(err)?;
            if is_owner && !existing.is_owner {
                storage.set_owner(&existing.id).map_err(err)?;
            }
            storage.speaker_by_name(&name).map_err(err)?.ok_or("speaker vanished")?
        }
        None => storage.add_speaker(&name, is_owner, &serde_json::to_string(&print).map_err(err)?).map_err(err)?,
    };
    let _ = app.emit("speakers://changed", ());
    Ok(result)
}

#[tauri::command]
pub fn speaker_rename(app: AppHandle, state: State<'_, AppState>, id: String, name: String) -> CmdResult<()> {
    if name.trim().is_empty() {
        return Err("A name is needed.".into());
    }
    state.storage.rename_speaker(&id, &name).map_err(err)?;
    let _ = app.emit("speakers://changed", ());
    Ok(())
}

#[tauri::command]
pub fn speaker_set_owner(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.storage.set_owner(&id).map_err(err)?;
    let _ = app.emit("speakers://changed", ());
    Ok(())
}

#[tauri::command]
pub fn speaker_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.storage.delete_speaker(&id).map_err(err)?;
    let _ = app.emit("speakers://changed", ());
    Ok(())
}

#[tauri::command]
pub fn speakers_clear(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    state.storage.delete_all_speakers().map_err(err)?;
    let _ = app.emit("speakers://changed", ());
    Ok(())
}
