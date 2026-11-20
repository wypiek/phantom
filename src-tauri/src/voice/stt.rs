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

/// How a clip should be decoded.
#[derive(Clone, Debug, Default)]
pub struct DecodeOptions {
    /// Language code, "auto", or empty for English.
    pub language: String,
    /// Beam search (more accurate, ~2× slower). Live previews use greedy.
    pub accurate: bool,
    /// Words Whisper should expect (Noli, people's names…). Biases spelling.
    pub vocabulary: Vec<String>,
    /// Model name, used to force English on `.en` models.
    pub model: String,
}

/// Builds Whisper's initial prompt: a short natural sentence works better
/// than a bare word list and also nudges it toward punctuated output.
pub fn vocabulary_prompt(words: &[String]) -> String {
    let mut seen: Vec<String> = vec![];
    for w in words {
        let w = w.trim();
        if !w.is_empty() && w.len() < 40 && !seen.iter().any(|s| s.eq_ignore_ascii_case(w)) {
            seen.push(w.to_string());
        }
        if seen.len() >= 12 {
            break;
        }
    }
    let mut p = String::from("Hey Noli, it's me.");
    if !seen.is_empty() {
        p.push_str(&format!(" With {}.", seen.join(", ")));
    }
    p
}

/// Transcribes 16 kHz mono audio (already prepared, see `capture::prepare_for_stt`).
pub fn transcribe(ctx: &WhisperContext, audio_16k: &[f32], opts: &DecodeOptions) -> Result<String> {
    if audio_16k.len() < 16_000 / 4 {
        return Ok(String::new());
    }
    // Whisper needs at least 1 s; pad short clips with silence.
    let mut audio = audio_16k.to_vec();
    if audio.len() < 16_000 + 1600 {
        audio.resize(16_000 + 1600, 0.0);
    }
    let mut state = ctx.create_state().map_err(|e| anyhow!("whisper state: {e}"))?;
    let strategy = if opts.accurate { SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 } } else { SamplingStrategy::Greedy { best_of: 1 } };
    let mut params = FullParams::new(strategy);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8) as i32;
    params.set_n_threads(threads);
    params.set_translate(false);
    let lang = language_for(&opts.language, &opts.model);
    params.set_language(Some(lang));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_context(true);
    params.set_single_segment(audio.len() < 16_000 * 12);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    // fall back to sampling when greedy/beam output looks like a loop or gibberish
    params.set_temperature(0.0);
    params.set_temperature_inc(0.2);
    params.set_entropy_thold(2.4);
    params.set_logprob_thold(-1.0);
    params.set_no_speech_thold(0.6);
    let prompt = vocabulary_prompt(&opts.vocabulary);
    params.set_initial_prompt(&prompt);
    state.full(params, &audio).map_err(|e| anyhow!("transcription failed: {e}"))?;
    let mut text = String::new();
    for seg in state.as_iter() {
        // Whisper's own "this was not speech" estimate: drop those segments.
        if seg.no_speech_probability() > 0.72 {
            continue;
        }
        if let Ok(s) = seg.to_str_lossy() {
            text.push_str(&s);
        }
    }
    let cleaned = clean_transcript(&text);
    // On near-silence Whisper sometimes just repeats its prompt back.
    if is_prompt_echo(&cleaned, &prompt) {
        return Ok(String::new());
    }
    Ok(cleaned)
}

fn language_for<'a>(language: &'a str, model: &str) -> &'a str {
    let l = language.trim();
    if model.ends_with(".en") || l.is_empty() {
        "en"
    } else {
        l
    }
}

fn normalize_words(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_prompt_echo(text: &str, prompt: &str) -> bool {
    let t = normalize_words(text);
    !t.is_empty() && normalize_words(prompt).contains(&t) && t.split(' ').count() >= 2
}

/// Removes Whisper's non-speech annotations ("[BLANK_AUDIO]", "(wind blowing)",
/// "♪"), collapses looped repeats and drops the classic silence hallucinations.
pub fn clean_transcript(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut depth = 0i32;
    let mut in_star = false;
    for ch in raw.chars() {
        match ch {
            '[' | '(' => depth += 1,
            ']' | ')' => depth = (depth - 1).max(0),
            '*' => in_star = !in_star,
            '♪' | '♫' | '🎵' | '🎶' => {}
            _ if depth > 0 || in_star => {}
            _ => out.push(ch),
        }
    }
    let t = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = collapse_repeats(&t);
    let lower = normalize_words(&t);
    const HALLUCINATIONS: &[&str] = &[
        "thank you",
        "thanks for watching",
        "thank you for watching",
        "thank you so much for watching",
        "thanks for watching and see you next time",
        "please subscribe",
        "like and subscribe",
        "subscribe to my channel",
        "you",
        "bye",
        "bye bye",
        "so",
        "hmm",
        "um",
        "uh",
        "subtitles by the amaraorg community",
        "transcribed by",
        "see you next time",
        "i'll see you next time",
    ];
    if lower.is_empty() || HALLUCINATIONS.contains(&lower.as_str()) || lower.starts_with("subtitles by") || lower.starts_with("captions by") {
        return String::new();
    }
    // nothing but punctuation
    if !t.chars().any(|c| c.is_alphanumeric()) {
        return String::new();
    }
    t
}

/// Whisper sometimes loops: "Open the door. Open the door. Open the door."
/// Keeps the first of any run of identical sentences.
fn collapse_repeats(text: &str) -> String {
    let mut sentences: Vec<&str> = vec![];
    let mut start = 0;
    for (i, c) in text.char_indices() {
        if matches!(c, '.' | '!' | '?') {
            let end = i + c.len_utf8();
            sentences.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        sentences.push(&text[start..]);
    }
    let mut out: Vec<&str> = vec![];
    for s in sentences {
        let s_trim = s.trim();
        if s_trim.is_empty() {
            continue;
        }
        if out.last().is_some_and(|p| normalize_words(p) == normalize_words(s_trim) && !normalize_words(s_trim).is_empty()) {
            continue;
        }
        out.push(s_trim);
    }
    out.join(" ")
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
    use super::*;

    #[test]
    fn strips_annotations_and_hallucinations() {
        assert_eq!(clean_transcript(" [BLANK_AUDIO] "), "");
        assert_eq!(clean_transcript(" Hello (wind blowing) there. "), "Hello there.");
        assert_eq!(clean_transcript(" Thank you."), "");
        assert_eq!(clean_transcript(" What time is it?"), "What time is it?");
        assert_eq!(clean_transcript("*music* open the pod bay doors"), "open the pod bay doors");
        assert_eq!(clean_transcript(" Thanks for watching!"), "");
        assert_eq!(clean_transcript(" ♪ ♪ "), "");
        assert_eq!(clean_transcript(" ..."), "");
    }

    #[test]
    fn collapses_looped_sentences() {
        assert_eq!(clean_transcript("Open the door. Open the door. Open the door."), "Open the door.");
        assert_eq!(clean_transcript("Yes. No. Yes."), "Yes. No. Yes.");
    }

    #[test]
    fn prompt_includes_names_once() {
        let p = vocabulary_prompt(&["Ada".into(), "ada".into(), " Bob ".into()]);
        assert_eq!(p, "Hey Noli, it's me. With Ada, Bob.");
        assert!(is_prompt_echo("Hey Noli, it's me.", &p));
        assert!(!is_prompt_echo("Hey Noli, open Safari.", &p));
    }

    #[test]
    fn english_models_force_english() {
        assert_eq!(language_for("auto", "base.en"), "en");
        assert_eq!(language_for("de", "small"), "de");
        assert_eq!(language_for("", "small"), "en");
    }

    /// End-to-end check with a real model: `WHISPER_MODEL=ggml-base.en.bin ASR_DIR=dir-with-NN.wav+NN.txt
    /// cargo test --release --lib asr_end_to_end -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn asr_end_to_end() {
        let (Ok(model), Ok(dir)) = (std::env::var("WHISPER_MODEL"), std::env::var("ASR_DIR")) else { return };
        let ctx = WhisperContext::new_with_params(&model, WhisperContextParameters::default()).unwrap();
        let words = |s: &str| normalize_words(s).split(' ').filter(|w| !w.is_empty()).map(String::from).collect::<Vec<_>>();
        let wer = |r: &[String], h: &[String]| {
            let mut d: Vec<Vec<usize>> = (0..=r.len()).map(|i| (0..=h.len()).map(|j| if i == 0 { j } else if j == 0 { i } else { 0 }).collect()).collect();
            for i in 1..=r.len() {
                for j in 1..=h.len() {
                    d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + (r[i - 1] != h[j - 1]) as usize);
                }
            }
            d[r.len()][h.len()]
        };
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "wav")).collect();
        files.sort();
        let (mut ref_n, mut err_old, mut err_new) = (0, 0, 0);
        let (mut t_old, mut t_new) = (0.0, 0.0);
        for f in files {
            let reference = std::fs::read_to_string(f.with_extension("txt")).unwrap();
            let mut r = hound::WavReader::open(&f).unwrap();
            let rate = r.spec().sample_rate;
            let raw: Vec<f32> = r.samples::<i16>().map(|v| v.unwrap() as f32 / 32768.0).collect();
            let audio = crate::voice::capture::resample_to_16k(&raw, rate);
            let old_opts = DecodeOptions { language: "en".into(), accurate: false, vocabulary: vec![], model: "base.en".into() };
            let t = std::time::Instant::now();
            let old = transcribe(&ctx, &audio, &old_opts).unwrap();
            t_old += t.elapsed().as_secs_f32();
            let mode = std::env::var("MODE").unwrap_or_default();
            let prepared = if mode.contains("raw") { audio.clone() } else { crate::voice::capture::prepare_for_stt(&audio) };
            let new_opts = DecodeOptions { accurate: !mode.contains("greedy"), ..old_opts.clone() };
            let t = std::time::Instant::now();
            let new = transcribe(&ctx, &prepared, &new_opts).unwrap();
            t_new += t.elapsed().as_secs_f32();
            let rw = words(&reference);
            let (eo, en) = (wer(&rw, &words(&old)), wer(&rw, &words(&new)));
            ref_n += rw.len();
            err_old += eo;
            err_new += en;
            if eo != en && std::env::var("VERBOSE").is_ok() {
                eprintln!("REF {reference}\n old({eo}) {old}\n new({en}) {new}");
            }
        }
        eprintln!("WER greedy/raw {:.1}% ({t_old:.1}s) → beam/prepared {:.1}% ({t_new:.1}s) over {ref_n} words", 100.0 * err_old as f32 / ref_n as f32, 100.0 * err_new as f32 / ref_n as f32);
    }
}
