//! Text-to-speech synthesis. Produces raw WAV bytes per sentence; the horror
//! effect chain (pitch, reverb, bitcrush, static…) is applied in real time by
//! the frontend audio graph so it can be tweaked live and interrupted instantly.
//!
//! Engines:
//! * `system` — macOS `say`, Windows SAPI (PowerShell), Linux `espeak-ng`/`espeak`.
//! * `piper`  — local neural TTS (https://github.com/rhasspy/piper) with a
//!   downloaded `.onnx` voice.

use crate::state::{err, AppState, CmdResult};
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub language: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    system_available: bool,
    system_engine: String,
    piper_path: Option<String>,
    piper_models: Vec<String>,
    piper_models_dir: String,
}

pub struct PiperVoice {
    pub id: &'static str,
    pub path: &'static str,
    pub description: &'static str,
    pub size_mb: u32,
}

/// Curated Piper voices that suit PHANTOM (deep / clear male voices).
pub const PIPER_VOICES: &[PiperVoice] = &[
    PiperVoice { id: "en_US-ryan-medium", path: "en/en_US/ryan/medium", description: "US male, deep and clear", size_mb: 63 },
    PiperVoice { id: "en_GB-alan-medium", path: "en/en_GB/alan/medium", description: "British male, calm", size_mb: 63 },
    PiperVoice { id: "en_US-joe-medium", path: "en/en_US/joe/medium", description: "US male, low", size_mb: 63 },
    PiperVoice { id: "en_US-lessac-medium", path: "en/en_US/lessac/medium", description: "US neutral, very clear", size_mb: 63 },
];

fn piper_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("piper")
}

fn system_engine_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS Speech (say)"
    } else if cfg!(target_os = "windows") {
        "Windows SAPI"
    } else {
        "eSpeak NG"
    }
}

fn linux_espeak(path_env: Option<&str>) -> Option<PathBuf> {
    find_exe("espeak-ng", path_env).or_else(|| find_exe("espeak", path_env))
}

pub fn find_exe(name: &str, path_env: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = path_env {
        if let Ok(found) = which::which_in(name, Some(p), std::env::current_dir().unwrap_or_default()) {
            return Some(found);
        }
    }
    which::which(name).ok()
}

fn resolve_piper(state: &AppState) -> Option<PathBuf> {
    let configured = state.settings.read().tts.piper_path.clone();
    if !configured.trim().is_empty() {
        let p = PathBuf::from(configured.trim());
        return p.exists().then_some(p);
    }
    let bundled = piper_dir(state).join(if cfg!(windows) { "piper/piper.exe" } else { "piper/piper" });
    if bundled.exists() {
        return Some(bundled);
    }
    find_exe("piper", state.env_path.as_deref())
}

fn list_piper_models(dir: &Path) -> Vec<String> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "onnx").unwrap_or(false) && p.with_extension("onnx.json").exists() {
                if let Some(stem) = p.file_stem() {
                    out.push(stem.to_string_lossy().into_owned());
                }
            }
        }
    }
    out.sort();
    out
}

#[tauri::command]
pub fn tts_status(state: State<'_, AppState>) -> TtsStatus {
    let system_available = if cfg!(target_os = "linux") { linux_espeak(state.env_path.as_deref()).is_some() } else { true };
    let dir = piper_dir(&state);
    TtsStatus {
        system_available,
        system_engine: system_engine_name().into(),
        piper_path: resolve_piper(&state).map(|p| p.to_string_lossy().into_owned()),
        piper_models: list_piper_models(&dir),
        piper_models_dir: dir.to_string_lossy().into_owned(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiperVoiceEntry {
    id: String,
    description: String,
    size_mb: u32,
    downloaded: bool,
}

#[tauri::command]
pub fn tts_piper_voices(state: State<'_, AppState>) -> Vec<PiperVoiceEntry> {
    let installed = list_piper_models(&piper_dir(&state));
    PIPER_VOICES
        .iter()
        .map(|v| PiperVoiceEntry { id: v.id.into(), description: v.description.into(), size_mb: v.size_mb, downloaded: installed.iter().any(|i| i == v.id) })
        .collect()
}

#[tauri::command]
pub async fn tts_download_piper_voice(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let voice = PIPER_VOICES.iter().find(|v| v.id == id).ok_or("unknown voice")?;
    let dir = piper_dir(&state);
    tokio::fs::create_dir_all(&dir).await.map_err(err)?;
    let base = format!("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/{}/{}", voice.path, voice.id);
    for ext in ["onnx.json", "onnx"] {
        let url = format!("{base}.{ext}");
        let dest = dir.join(format!("{}.{ext}", voice.id));
        let part = dir.join(format!("{}.{ext}.part", voice.id));
        let resp = state.http.get(&url).send().await.map_err(err)?.error_for_status().map_err(err)?;
        let total = resp.content_length();
        let mut f = tokio::fs::File::create(&part).await.map_err(err)?;
        let mut stream = resp.bytes_stream();
        let mut got = 0u64;
        use tokio::io::AsyncWriteExt;
        while let Some(c) = stream.next().await {
            let c = c.map_err(err)?;
            got += c.len() as u64;
            f.write_all(&c).await.map_err(err)?;
            if ext == "onnx" && got % (1 << 20) < c.len() as u64 {
                let _ = app.emit("tts://piper-progress", serde_json::json!({ "id": id, "received": got, "total": total }));
            }
        }
        f.flush().await.map_err(err)?;
        drop(f);
        tokio::fs::rename(&part, &dest).await.map_err(err)?;
    }
    let _ = app.emit("tts://piper-progress", serde_json::json!({ "id": id, "done": true }));
    Ok(())
}

#[tauri::command]
pub async fn tts_list_voices(state: State<'_, AppState>) -> CmdResult<Vec<VoiceInfo>> {
    list_system_voices(state.env_path.as_deref()).await.map_err(err)
}

async fn list_system_voices(path_env: Option<&str>) -> Result<Vec<VoiceInfo>> {
    if cfg!(target_os = "macos") {
        let out = Command::new("/usr/bin/say").arg("-v").arg("?").output().await?;
        let text = String::from_utf8_lossy(&out.stdout);
        Ok(parse_say_voices(&text))
    } else if cfg!(target_os = "windows") {
        let script = "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";
        let out = powershell(script).output().await?;
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let (n, lang) = l.trim().split_once('|')?;
                Some(VoiceInfo { id: n.into(), name: n.into(), language: lang.into() })
            })
            .collect())
    } else {
        let bin = linux_espeak(path_env).ok_or_else(|| anyhow!("espeak-ng is not installed"))?;
        let out = Command::new(bin).arg("--voices=en").output().await?;
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .skip(1)
            .filter_map(|l| {
                let cols: Vec<&str> = l.split_whitespace().collect();
                let id = cols.get(4)?.to_string();
                Some(VoiceInfo { name: cols.get(3).unwrap_or(&"").to_string(), language: cols.get(1).unwrap_or(&"").to_string(), id })
            })
            .collect())
    }
}

/// Parses `say -v ?` output: `Name (Variant)   en_US    # sample text`.
pub fn parse_say_voices(text: &str) -> Vec<VoiceInfo> {
    let mut out = vec![];
    for line in text.lines() {
        let Some((left, _)) = line.split_once('#') else { continue };
        let left = left.trim_end();
        let Some(idx) = left.rfind(char::is_whitespace) else { continue };
        let lang = left[idx..].trim().to_string();
        let name = left[..idx].trim().to_string();
        if name.is_empty() || !lang.contains('_') {
            continue;
        }
        out.push(VoiceInfo { id: name.clone(), name, language: lang });
    }
    out
}

#[cfg(windows)]
fn powershell(script: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    c.as_std_mut().creation_flags(0x08000000); // CREATE_NO_WINDOW
    c
}

#[cfg(not(windows))]
fn powershell(script: &str) -> Command {
    let mut c = Command::new("pwsh");
    c.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    c
}

/// Synthesizes `text` and returns a WAV file as bytes.
///
/// `rate` is a speed multiplier (1.0 = engine default). The frontend passes a
/// rate already compensated for its pitch shift so pitch and speed are independent.
#[tauri::command]
pub async fn tts_synthesize(
    state: State<'_, AppState>,
    text: String,
    rate: Option<f64>,
    engine: Option<String>,
    voice: Option<String>,
) -> CmdResult<tauri::ipc::Response> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("nothing to say".into());
    }
    let (cfg_engine, cfg_voice, piper_model) = {
        let s = state.settings.read();
        (s.tts.engine.clone(), s.tts.system_voice.clone(), s.tts.piper_model.clone())
    };
    let engine = engine.unwrap_or(cfg_engine);
    let voice = voice.unwrap_or(cfg_voice);
    let rate = rate.unwrap_or(1.0).clamp(0.3, 3.0);
    let tmp_dir = state.cache_dir.join("tts");
    tokio::fs::create_dir_all(&tmp_dir).await.map_err(err)?;
    let id = uuid::Uuid::new_v4().to_string();
    let wav = tmp_dir.join(format!("{id}.wav"));
    let txt = tmp_dir.join(format!("{id}.txt"));
    tokio::fs::write(&txt, &text).await.map_err(err)?;

    let result = if engine == "piper" {
        let bin = resolve_piper(&state).ok_or_else(|| "Piper is not installed. See Settings → Voice.".to_string())?;
        let model_name = if piper_model.is_empty() { list_piper_models(&piper_dir(&state)).into_iter().next().unwrap_or_default() } else { piper_model };
        let model = piper_dir(&state).join(format!("{model_name}.onnx"));
        if !model.exists() {
            return Err("No Piper voice downloaded yet. See Settings → Voice.".into());
        }
        synth_piper(&bin, &model, &text, rate, &wav).await
    } else {
        synth_system(&voice, rate, &txt, &wav, state.env_path.as_deref()).await
    };
    let _ = tokio::fs::remove_file(&txt).await;
    result.map_err(err)?;
    let bytes = tokio::fs::read(&wav).await.map_err(err)?;
    let _ = tokio::fs::remove_file(&wav).await;
    if bytes.len() < 64 {
        return Err("speech engine produced no audio".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

async fn run_checked(mut cmd: Command, what: &str) -> Result<()> {
    cmd.kill_on_drop(true);
    let out = cmd.output().await.with_context(|| format!("could not start {what}"))?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("{what} failed: {}", e.trim()));
    }
    Ok(())
}

async fn synth_system(voice: &str, rate: f64, txt: &Path, wav: &Path, path_env: Option<&str>) -> Result<()> {
    if cfg!(target_os = "macos") {
        let mut c = Command::new("/usr/bin/say");
        if !voice.is_empty() {
            c.arg("-v").arg(voice);
        }
        let wpm = (180.0 * rate).round() as i64;
        c.arg("-r").arg(wpm.to_string()).arg("--data-format=LEI16@22050").arg("-o").arg(wav).arg("-f").arg(txt);
        run_checked(c, "macOS speech").await
    } else if cfg!(target_os = "windows") {
        let sapi_rate = ((rate - 1.0) * 10.0).round().clamp(-10.0, 10.0) as i64;
        let esc = |p: &Path| p.to_string_lossy().replace('\'', "''");
        let select = if voice.is_empty() { String::new() } else { format!("$s.SelectVoice('{}');", voice.replace('\'', "''")) };
        let script = format!(
            "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; {select} $s.Rate = {sapi_rate}; $s.SetOutputToWaveFile('{}'); $s.Speak([IO.File]::ReadAllText('{}')); $s.Dispose()",
            esc(wav),
            esc(txt)
        );
        run_checked(powershell(&script), "Windows speech").await
    } else {
        let bin = linux_espeak(path_env).ok_or_else(|| anyhow!("Install espeak-ng (e.g. `sudo apt install espeak-ng`) or use Piper."))?;
        let mut c = Command::new(bin);
        if !voice.is_empty() {
            c.arg("-v").arg(voice);
        }
        c.arg("-s").arg(((165.0 * rate).round() as i64).to_string()).arg("-w").arg(wav).arg("-f").arg(txt);
        run_checked(c, "eSpeak").await
    }
}

async fn synth_piper(bin: &Path, model: &Path, text: &str, rate: f64, wav: &Path) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut c = Command::new(bin);
    c.arg("--model").arg(model).arg("--output_file").arg(wav).arg("--length_scale").arg(format!("{:.3}", 1.0 / rate)).arg("--sentence_silence").arg("0.15");
    c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    let mut child = c.spawn().context("could not start piper")?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.replace('\n', " ").as_bytes()).await?;
        stdin.write_all(b"\n").await?;
    }
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        return Err(anyhow!("piper failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_say_voice_list() {
        let sample = "Albert              en_US    # Hello! My name is Albert.\nEddy (English (UK)) en_GB    # Hello! My name is Eddy.\nbroken line\n";
        let v = parse_say_voices(sample);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].name, "Albert");
        assert_eq!(v[1].name, "Eddy (English (UK))");
        assert_eq!(v[1].language, "en_GB");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn macos_say_produces_wav() {
        let dir = tempfile::tempdir().unwrap();
        let txt = dir.path().join("t.txt");
        let wav = dir.path().join("t.wav");
        std::fs::write(&txt, "I live in your computer.").unwrap();
        synth_system("", 1.0, &txt, &wav, None).await.unwrap();
        let r = hound::WavReader::open(&wav).unwrap();
        assert_eq!(r.spec().sample_rate, 22050);
        assert!(r.duration() > 22050 / 2);
    }
}
