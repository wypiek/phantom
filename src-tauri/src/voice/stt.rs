//! Local speech recognition with whisper.cpp (via whisper-rs).
//! Models are downloaded on demand into `<app data>/models/` and loaded lazily.

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub struct WhisperModelInfo {
    pub name: &'static str,
    pub size_mb: u32,
    pub description: &'static str,
}

pub const MODELS: &[WhisperModelInfo] = &[
    WhisperModelInfo { name: "tiny.en", size_mb: 75, description: "Fastest, English only, rougher accuracy" },
    WhisperModelInfo { name: "base.en", size_mb: 142, description: "Recommended — fast and accurate, English only" },
    WhisperModelInfo { name: "small.en", size_mb: 466, description: "Most accurate English, slower" },
    WhisperModelInfo { name: "base", size_mb: 142, description: "Multilingual" },
    WhisperModelInfo { name: "small", size_mb: 466, description: "Multilingual, more accurate" },
];

pub fn model_url(name: &str) -> String {
    format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin")
}

pub fn model_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("ggml-{name}.bin"))
}

pub fn is_known_model(name: &str) -> bool {
    MODELS.iter().any(|m| m.name == name)
}

pub struct Stt {
    loaded: Mutex<Option<(String, Arc<WhisperContext>)>>,
}

impl Stt {
    pub fn new() -> Self {
        Self { loaded: Mutex::new(None) }
    }

    /// Loads (or reuses) the given model file.
    pub fn context(&self, models_dir: &Path, name: &str) -> Result<Arc<WhisperContext>> {
        let mut guard = self.loaded.lock();
        if let Some((n, ctx)) = guard.as_ref() {
            if n == name {
                return Ok(ctx.clone());
            }
        }
        let path = model_path(models_dir, name);
        if !path.exists() {
            return Err(anyhow!("speech model \"{name}\" is not downloaded yet — open Settings → Voice to download it"));
        }
        let ctx = WhisperContext::new_with_params(path.to_str().context("model path not UTF-8")?, WhisperContextParameters::default())
            .map_err(|e| anyhow!("failed to load speech model: {e}"))?;
        let ctx = Arc::new(ctx);
        *guard = Some((name.to_string(), ctx.clone()));
        Ok(ctx)
    }

    /// Frees the model from memory (e.g. when voice is disabled).
    pub fn unload(&self) {
        *self.loaded.lock() = None;
    }
}

/// Transcribes 16 kHz mono audio.
pub fn transcribe(ctx: &WhisperContext, audio_16k: &[f32], language: &str) -> Result<String> {
    if audio_16k.len() < 16_000 / 4 {
        return Ok(String::new());
    }
    // Whisper needs at least 1 s; pad short clips with silence.
    let mut audio = audio_16k.to_vec();
    if audio.len() < 16_000 + 1600 {
        audio.resize(16_000 + 1600, 0.0);
    }
    let mut state = ctx.create_state().map_err(|e| anyhow!("whisper state: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8) as i32;
    params.set_n_threads(threads);
    params.set_translate(false);
    let lang = if language.trim().is_empty() { "en" } else { language };
    params.set_language(Some(lang));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    state.full(params, &audio).map_err(|e| anyhow!("transcription failed: {e}"))?;
    let mut text = String::new();
    for seg in state.as_iter() {
        if let Ok(s) = seg.to_str_lossy() {
            text.push_str(&s);
        }
    }
    Ok(clean_transcript(&text))
}

/// Removes Whisper's non-speech annotations ("[BLANK_AUDIO]", "(wind blowing)")
/// and the classic silence hallucinations.
pub fn clean_transcript(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut depth = 0i32;
    let mut in_star = false;
    for ch in raw.chars() {
        match ch {
            '[' | '(' => depth += 1,
            ']' | ')' => depth = (depth - 1).max(0),
            '*' => in_star = !in_star,
            _ if depth > 0 || in_star => {}
            _ => out.push(ch),
        }
    }
    let t = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = t.to_lowercase();
    const HALLUCINATIONS: &[&str] = &["thank you.", "thanks for watching!", "thank you for watching.", "you", "bye.", "."];
    if HALLUCINATIONS.contains(&lower.as_str()) {
        return String::new();
    }
    t
}

/// Downloads a model with progress callbacks; writes to `.part` then renames.
pub async fn download_model(
    client: &reqwest::Client,
    dir: &Path,
    name: &str,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    if !is_known_model(name) {
        return Err(anyhow!("unknown model {name}"));
    }
    tokio::fs::create_dir_all(dir).await?;
    let dest = model_path(dir, name);
    let part = dest.with_extension("bin.part");
    let resp = client.get(model_url(name)).send().await?.error_for_status().context("model download failed")?;
    let total = resp.content_length();
    let mut file = tokio::fs::File::create(&part).await?;
    let mut stream = resp.bytes_stream();
    let mut received = 0u64;
    let mut last_report = 0u64;
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("download interrupted")?;
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        if received - last_report > 512 * 1024 {
            last_report = received;
            progress(received, total);
        }
    }
    file.flush().await?;
    drop(file);
    if received < 1_000_000 || total.map(|t| t != received).unwrap_or(false) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(anyhow!("downloaded model is incomplete ({received} bytes)"));
    }
    tokio::fs::rename(&part, &dest).await?;
    progress(received, total);
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::clean_transcript;

    #[test]
    fn strips_annotations_and_hallucinations() {
        assert_eq!(clean_transcript(" [BLANK_AUDIO] "), "");
        assert_eq!(clean_transcript(" Hello (wind blowing) there. "), "Hello there.");
        assert_eq!(clean_transcript(" Thank you."), "");
        assert_eq!(clean_transcript(" What time is it?"), "What time is it?");
        assert_eq!(clean_transcript("*music* open the pod bay doors"), "open the pod bay doors");
    }
}
