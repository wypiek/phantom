//! Microphone capture via cpal. The cpal stream is not `Send` on every
//! platform, so it lives on its own thread and is controlled through a
//! shared stop flag.

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub name: String,
    pub is_default: bool,
}

pub fn list_input_devices() -> Result<Vec<InputDevice>> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());
    let mut out = vec![];
    for d in host.input_devices().map_err(|e| anyhow!("cannot enumerate microphones: {e}"))? {
        if let Ok(name) = d.name() {
            out.push(InputDevice { is_default: Some(&name) == default.as_ref(), name });
        }
    }
    Ok(out)
}

/// Audio shared between the capture thread and consumers.
pub struct CaptureShared {
    /// Mono samples at `sample_rate`.
    pub samples: Mutex<Vec<f32>>,
    pub sample_rate: AtomicU32,
    /// RMS of the most recent callback block (f32 bits).
    pub level: AtomicU32,
    pub stop: AtomicBool,
    pub failed: Mutex<Option<String>>,
}

impl CaptureShared {
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
}

pub struct Capture {
    pub shared: Arc<CaptureShared>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    /// Opens the named device (or the default one) and starts recording.
    pub fn start(device_name: &str, gain: f32) -> Result<Capture> {
        let shared = Arc::new(CaptureShared {
            samples: Mutex::new(Vec::with_capacity(48_000 * 10)),
            sample_rate: AtomicU32::new(0),
            level: AtomicU32::new(0),
            stop: AtomicBool::new(false),
            failed: Mutex::new(None),
        });
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<()>>();
        let sh = shared.clone();
        let name = device_name.to_string();
        let thread = std::thread::Builder::new()
            .name("phantom-mic".into())
            .spawn(move || {
                let stream = match open_stream(&name, sh.clone(), gain) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(anyhow!("microphone refused to start: {e}")));
                    return;
                }
                let _ = ready_tx.send(Ok(()));
                while !sh.stop.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                drop(stream);
            })?;
        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Capture { shared, thread: Some(thread) }),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                shared.stop.store(true, Ordering::Relaxed);
                Err(anyhow!("timed out opening the microphone"))
            }
        }
    }

    pub fn stop(mut self) -> Arc<CaptureShared> {
        self.shared.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        self.shared.clone()
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
    }
}

fn open_stream(device_name: &str, shared: Arc<CaptureShared>, gain: f32) -> Result<cpal::Stream> {
    let host = cpal::default_host();
    let device = if device_name.is_empty() {
        host.default_input_device().ok_or_else(|| anyhow!("no microphone found"))?
    } else {
        host.input_devices()?
            .find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
            .or_else(|| host.default_input_device())
            .ok_or_else(|| anyhow!("microphone \"{device_name}\" not found"))?
    };
    let config = device.default_input_config().map_err(|e| anyhow!("microphone unavailable (permission denied?): {e}"))?;
    let channels = config.channels() as usize;
    shared.sample_rate.store(config.sample_rate().0, Ordering::Relaxed);
    let err_shared = shared.clone();
    let err_fn = move |e: cpal::StreamError| {
        *err_shared.failed.lock() = Some(e.to_string());
    };
    let stream_config: cpal::StreamConfig = config.clone().into();

    fn push<T: Copy>(shared: &CaptureShared, data: &[T], channels: usize, gain: f32, conv: impl Fn(T) -> f32) {
        let mut sum = 0.0f32;
        let mut mono = Vec::with_capacity(data.len() / channels.max(1));
        for frame in data.chunks(channels.max(1)) {
            let s = (frame.iter().map(|&v| conv(v)).sum::<f32>() / frame.len() as f32 * gain).clamp(-1.0, 1.0);
            sum += s * s;
            mono.push(s);
        }
        let rms = if mono.is_empty() { 0.0 } else { (sum / mono.len() as f32).sqrt() };
        shared.level.store(rms.to_bits(), Ordering::Relaxed);
        shared.samples.lock().extend_from_slice(&mono);
    }

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let sh = shared.clone();
            device.build_input_stream(&stream_config, move |d: &[f32], _| push(&sh, d, channels, gain, |v| v), err_fn, None)?
        }
        cpal::SampleFormat::I16 => {
            let sh = shared.clone();
            device.build_input_stream(&stream_config, move |d: &[i16], _| push(&sh, d, channels, gain, |v| v as f32 / 32768.0), err_fn, None)?
        }
        cpal::SampleFormat::U16 => {
            let sh = shared.clone();
            device.build_input_stream(&stream_config, move |d: &[u16], _| push(&sh, d, channels, gain, |v| (v as f32 - 32768.0) / 32768.0), err_fn, None)?
        }
        cpal::SampleFormat::I32 => {
            let sh = shared.clone();
            device.build_input_stream(&stream_config, move |d: &[i32], _| push(&sh, d, channels, gain, |v| v as f32 / 2_147_483_648.0), err_fn, None)?
        }
        other => return Err(anyhow!("unsupported microphone sample format {other:?}")),
    };
    Ok(stream)
}

/// Resamples mono audio to 16 kHz for Whisper using a windowed-sinc
/// (Blackman) low-pass, so speech above 8 kHz doesn't alias back into the
/// band Whisper listens to. Gain is normalised per output sample, which also
/// keeps the edges clean.
pub fn resample_to_16k(input: &[f32], from_rate: u32) -> Vec<f32> {
    const TARGET: f64 = 16_000.0;
    if from_rate == 16_000 || input.is_empty() || from_rate == 0 {
        return input.to_vec();
    }
    let ratio = from_rate as f64 / TARGET;
    // cutoff as a fraction of the input sample rate (×2 = of Nyquist), with a little headroom
    let fc = (1.0 / ratio).min(1.0) * 0.92;
    let half = (10.0 / fc).ceil() as i64;
    let out_len = (input.len() as f64 / ratio) as usize;
    let n = input.len() as i64;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let center = pos.floor() as i64;
        let (mut acc, mut wsum) = (0.0f64, 0.0f64);
        for k in (center - half + 1).max(0)..=(center + half).min(n - 1) {
            let t = pos - k as f64;
            let x = fc * t;
            let sinc = if x.abs() < 1e-9 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
            // Blackman window over [-half, half]
            let u = (t / half as f64 + 1.0) * 0.5;
            if !(0.0..=1.0).contains(&u) {
                continue;
            }
            let w = 0.42 - 0.5 * (std::f64::consts::TAU * u).cos() + 0.08 * (2.0 * std::f64::consts::TAU * u).cos();
            let h = sinc * w;
            acc += input[k as usize] as f64 * h;
            wsum += h;
        }
        out.push(if wsum.abs() > 1e-9 { (acc / wsum) as f32 } else { 0.0 });
    }
    out
}

/// Cleans 16 kHz speech before recognition: removes DC offset and rumble
/// below ~70 Hz, trims long leading/trailing silence (a common trigger for
/// Whisper hallucinations) and normalises the level so quiet microphones are
/// recognised as well as loud ones.
pub fn prepare_for_stt(audio: &[f32]) -> Vec<f32> {
    if audio.is_empty() {
        return vec![];
    }
    // one-pole high-pass, fc ≈ 70 Hz
    let a = 1.0 / (1.0 + std::f32::consts::TAU * 70.0 / 16_000.0);
    let mut hp = Vec::with_capacity(audio.len());
    let (mut prev_x, mut prev_y) = (audio[0], 0.0f32);
    for &x in audio {
        let y = a * (prev_y + x - prev_x);
        hp.push(y);
        prev_x = x;
        prev_y = y;
    }
    let trimmed = trim_silence(&hp, 16_000);
    normalize(trimmed)
}

/// Frame energies (RMS) over 20 ms frames.
fn frame_rms(audio: &[f32], rate: usize) -> Vec<f32> {
    let frame = (rate / 50).max(1);
    audio.chunks(frame).map(rms).collect()
}

/// Cuts long silence at both ends, keeping 400 ms of padding around the
/// speech. Deliberately conservative: in a noisy room (speech less than
/// ~15 dB above the background) nothing is trimmed, because quiet syllables
/// can't be told apart from noise and cutting them costs far more accuracy
/// than the silence does.
pub fn trim_silence(audio: &[f32], rate: usize) -> &[f32] {
    let frame = (rate / 50).max(1);
    let energies = frame_rms(audio, rate);
    if energies.len() < 25 {
        return audio;
    }
    let mut sorted = energies.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let floor = sorted[sorted.len() / 10].max(1e-5);
    let peak = sorted[sorted.len() - 1];
    if peak < floor * 6.0 {
        return audio;
    }
    let gate = (floor * 2.0).max(peak * 0.03).max(0.0015);
    let first = energies.iter().position(|&e| e > gate).unwrap_or(0);
    let last = energies.iter().rposition(|&e| e > gate).unwrap_or(energies.len() - 1);
    let pad = rate * 2 / 5;
    let start = (first * frame).saturating_sub(pad);
    let end = ((last + 1) * frame + pad).min(audio.len());
    &audio[start..end]
}

/// Scales so loud speech peaks near -3 dBFS. Uses a high percentile rather
/// than the absolute peak so a single click can't dominate; boost is capped
/// so pure background noise isn't amplified into "speech".
fn normalize(audio: &[f32]) -> Vec<f32> {
    if audio.is_empty() {
        return vec![];
    }
    let mut mags: Vec<f32> = audio.iter().map(|s| s.abs()).collect();
    let idx = ((mags.len() as f32) * 0.998) as usize;
    let idx = idx.min(mags.len() - 1);
    let (_, p, _) = mags.select_nth_unstable_by(idx, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p = *p;
    if p < 1e-4 {
        return audio.to_vec();
    }
    let gain = (0.7 / p).clamp(0.5, 12.0);
    audio.iter().map(|s| (s * gain).clamp(-1.0, 1.0)).collect()
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_length_and_tone() {
        // 1 s of 440 Hz at 48 kHz → 16 000 samples, energy preserved
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5).collect();
        let out = resample_to_16k(&input, 48_000);
        assert!((out.len() as i64 - 16_000).abs() <= 1);
        let r = rms(&out);
        assert!(r > 0.3 && r < 0.4, "rms {r}");
    }

    #[test]
    fn resample_removes_aliasing() {
        // 11 kHz can't exist at 16 kHz; it must be filtered, not folded to 5 kHz
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 * 11_000.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5).collect();
        let out = resample_to_16k(&input, 48_000);
        assert!(rms(&out[200..out.len() - 200]) < 0.02, "aliased energy {}", rms(&out));
    }

    #[test]
    fn resample_44k_keeps_speech_band() {
        let input: Vec<f32> = (0..44_100).map(|i| (i as f32 * 1_000.0 * std::f32::consts::TAU / 44_100.0).sin() * 0.5).collect();
        let out = resample_to_16k(&input, 44_100);
        assert!((out.len() as i64 - 16_000).abs() <= 1);
        let r = rms(&out[100..out.len() - 100]);
        assert!(r > 0.33 && r < 0.38, "rms {r}");
    }

    #[test]
    fn prepare_trims_and_normalizes() {
        // 1 s silence (faint noise), 1 s quiet tone, 1 s silence
        let mut v: Vec<f32> = (0..16_000).map(|i| ((i * 7919) % 13) as f32 * 0.00005).collect();
        v.extend((0..16_000).map(|i| (i as f32 * 300.0 * std::f32::consts::TAU / 16_000.0).sin() * 0.05));
        v.extend((0..16_000).map(|i| ((i * 104_729) % 11) as f32 * 0.00005));
        let out = prepare_for_stt(&v);
        assert!(out.len() < 30_000 && out.len() > 16_000, "len {}", out.len());
        let peak = out.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.5 && peak <= 1.0, "peak {peak}");
    }

    #[test]
    fn noisy_recordings_are_not_trimmed() {
        // speech only ~6 dB above the noise: trimming would eat quiet syllables
        let v: Vec<f32> = (0..48_000)
            .map(|i| {
                let noise = (((i * 7919) % 101) as f32 / 101.0 - 0.5) * 0.012;
                let speech = if (16_000..32_000).contains(&i) { (i as f32 * 0.07).sin() * 0.012 } else { 0.0 };
                noise + speech
            })
            .collect();
        assert_eq!(trim_silence(&v, 16_000).len(), v.len());
    }

    #[test]
    fn passthrough_16k() {
        let v = vec![0.1, 0.2, 0.3];
        assert_eq!(resample_to_16k(&v, 16_000), v);
    }
}
