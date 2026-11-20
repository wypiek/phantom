//! Lightweight speaker recognition ("voiceprints").
//!
//! Each utterance is summarised as the statistics of its MFCCs (a compact
//! description of the shape of someone's vocal tract) plus their pitch. Two
//! voiceprints are compared with a symmetric Kullback–Leibler divergence
//! between diagonal Gaussians. A known person's profile keeps absorbing new
//! utterances, and also learns how much that person's voice normally varies,
//! so the "is this someone new?" decision adapts per person.
//!
//! This runs locally in a few milliseconds and needs no model download. It
//! tells different people apart well in a quiet room on the same microphone;
//! it is not a security feature.

use serde::{Deserialize, Serialize};

pub const RATE: usize = 16_000;
const FRAME: usize = 400; // 25 ms
const HOP: usize = 160; // 10 ms
const NFFT: usize = 512;
const MELS: usize = 26;
/// MFCC c1..c19 (c0 is loudness, which says nothing about who is talking).
pub const DIMS: usize = 19;
const VAR_FLOOR: f32 = 1e-3;
/// Minimum voiced speech for a usable voiceprint.
pub const MIN_FRAMES: u32 = 80;
/// A profile stops growing in weight here so it keeps adapting.
const PROFILE_MAX_FRAMES: u32 = 6_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Voiceprint {
    pub mean: Vec<f32>,
    pub var: Vec<f32>,
    /// Mean natural-log pitch (Hz) over voiced frames; 0 when unknown.
    pub log_f0: f32,
    pub log_f0_var: f32,
    pub f0_frames: u32,
    /// Speech frames summarised (the weight of this print).
    pub frames: u32,
    /// Running statistics of this person's own distances (profiles only).
    #[serde(default)]
    pub self_n: u32,
    #[serde(default)]
    pub self_mean: f32,
    #[serde(default)]
    pub self_m2: f32,
}

impl Voiceprint {
    /// Folds another utterance into this profile.
    pub fn merge(&mut self, other: &Voiceprint) {
        let wa = self.frames.min(PROFILE_MAX_FRAMES) as f32;
        let wb = other.frames as f32;
        let n = wa + wb;
        if n <= 0.0 {
            return;
        }
        for i in 0..DIMS {
            let (ma, mb) = (self.mean[i], other.mean[i]);
            let m = (wa * ma + wb * mb) / n;
            let v = (wa * (self.var[i] + ma * ma) + wb * (other.var[i] + mb * mb)) / n - m * m;
            self.mean[i] = m;
            self.var[i] = v.max(VAR_FLOOR);
        }
        let (fa, fb) = (self.f0_frames.min(PROFILE_MAX_FRAMES / 3) as f32, other.f0_frames as f32);
        if fa + fb > 0.0 {
            let (ma, mb) = (self.log_f0, other.log_f0);
            let m = (fa * ma + fb * mb) / (fa + fb);
            let v = (fa * (self.log_f0_var + ma * ma) + fb * (other.log_f0_var + mb * mb)) / (fa + fb) - m * m;
            self.log_f0 = m;
            self.log_f0_var = v.max(1e-4);
            self.f0_frames = (fa + fb) as u32;
        }
        self.frames = n as u32;
    }

    /// Records the distance of one of this person's own utterances.
    pub fn observe_self_distance(&mut self, d: f32) {
        self.self_n += 1;
        let delta = d - self.self_mean;
        self.self_mean += delta / self.self_n as f32;
        self.self_m2 += delta * (d - self.self_mean);
    }

    /// How far an utterance may be from this profile and still be this person.
    pub fn threshold(&self, base: f32) -> f32 {
        if self.self_n < 4 {
            return base;
        }
        let sd = (self.self_m2 / (self.self_n - 1) as f32).max(0.0).sqrt();
        (self.self_mean + 1.5 * sd).clamp(base * 0.8, base * 1.4)
    }
}

/// Symmetric KL divergence per MFCC dimension (averaged). 0 = identical.
///
/// Calibrated on 320 short clips from 40 LibriSpeech speakers: the same
/// person's sentences typically score ~0.1–0.4 against each other, different
/// people ~0.4–2+. Pitch is stored but deliberately not scored: on 2–5 s clips
/// it is too noisy and made recognition worse (EER 11 % → 18 %).
pub fn distance(a: &Voiceprint, b: &Voiceprint) -> f32 {
    let mut kl = 0.0f32;
    for i in 0..DIMS {
        let (va, vb) = (a.var[i].max(VAR_FLOOR), b.var[i].max(VAR_FLOOR));
        let dm = a.mean[i] - b.mean[i];
        kl += 0.5 * (va / vb + vb / va - 2.0 + dm * dm * (1.0 / va + 1.0 / vb));
    }
    kl / DIMS as f32
}

/// Strictness 0..1 → base distance threshold (higher strictness = lower threshold).
pub fn base_threshold(strictness: f32) -> f32 {
    // default 0.5 → 0.27: on the calibration set ~90 % of the owner's sentences are
    // recognised after one sample (~97 % after a few) and ~80–90 % of strangers are caught
    let s = strictness.clamp(0.0, 1.0);
    0.40 - 0.26 * s
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Clearly this person.
    Match,
    /// Probably this person, but not sure enough to learn from it.
    Likely,
    /// Clearly nobody we know.
    Unknown,
}

/// Classifies a distance against a profile's own threshold. Between "likely"
/// and "unknown" there is a deliberate gap so Noli doesn't keep asking people
/// it knows who they are.
pub fn verdict(d: f32, threshold: f32) -> Verdict {
    if d <= threshold * 0.8 {
        Verdict::Match
    } else if d <= threshold * 1.3 {
        Verdict::Likely
    } else {
        Verdict::Unknown
    }
}

// ---- feature extraction ---------------------------------------------------------

/// Computes a voiceprint from 16 kHz mono speech. `None` when there is too
/// little voiced speech to say anything about the speaker.
pub fn extract(audio: &[f32]) -> Option<Voiceprint> {
    // the most recent 20 s is plenty
    let audio = &audio[audio.len().saturating_sub(RATE * 20)..];
    if audio.len() < FRAME * 4 {
        return None;
    }
    let mut emph = Vec::with_capacity(audio.len());
    let mut prev = 0.0f32;
    for &x in audio {
        emph.push(x - 0.97 * prev);
        prev = x;
    }
    let fft = Fft::new(NFFT);
    let bank = mel_bank();
    let window: Vec<f32> = (0..FRAME).map(|i| 0.54 - 0.46 * (std::f32::consts::TAU * i as f32 / (FRAME - 1) as f32).cos()).collect();
    let mut energies_db = vec![];
    let mut ceps: Vec<[f32; DIMS]> = vec![];
    let mut starts = vec![];
    let mut re = vec![0.0f32; NFFT];
    let mut im = vec![0.0f32; NFFT];
    let mut start = 0;
    while start + FRAME <= emph.len() {
        let frame = &audio[start..start + FRAME];
        let e: f32 = frame.iter().map(|s| s * s).sum::<f32>() / FRAME as f32;
        energies_db.push(10.0 * (e + 1e-10).log10());
        re.iter_mut().for_each(|v| *v = 0.0);
        im.iter_mut().for_each(|v| *v = 0.0);
        for i in 0..FRAME {
            re[i] = emph[start + i] * window[i];
        }
        fft.run(&mut re, &mut im);
        let power: Vec<f32> = (0..=NFFT / 2).map(|k| re[k] * re[k] + im[k] * im[k]).collect();
        let mut logmel = [0.0f32; MELS];
        for (m, filt) in bank.iter().enumerate() {
            let s: f32 = filt.iter().map(|&(k, w)| power[k] * w).sum();
            logmel[m] = (s + 1e-8).ln();
        }
        let mut c = [0.0f32; DIMS];
        for (k, ck) in c.iter_mut().enumerate() {
            let kk = (k + 1) as f32;
            *ck = logmel.iter().enumerate().map(|(n, v)| v * (std::f32::consts::PI * kk * (n as f32 + 0.5) / MELS as f32).cos()).sum();
        }
        ceps.push(c);
        starts.push(start);
        start += HOP;
    }
    // keep frames that are clearly speech: near the loudest part and above the noise floor
    let mut sorted = energies_db.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let floor = sorted[sorted.len() / 10];
    let peak = sorted[sorted.len() - 1];
    if peak < -55.0 {
        return None;
    }
    // (never stricter than 12 dB under the peak, so dense speech with no pauses still counts)
    let gate = (peak - 30.0).max((floor + 8.0).min(peak - 12.0));
    let keep: Vec<usize> = (0..ceps.len()).filter(|&i| energies_db[i] > gate).collect();
    if (keep.len() as u32) < MIN_FRAMES {
        return None;
    }
    let n = keep.len() as f32;
    let mut mean = vec![0.0f32; DIMS];
    for &i in &keep {
        for d in 0..DIMS {
            mean[d] += ceps[i][d];
        }
    }
    mean.iter_mut().for_each(|m| *m /= n);
    let mut var = vec![0.0f32; DIMS];
    for &i in &keep {
        for d in 0..DIMS {
            let x = ceps[i][d] - mean[d];
            var[d] += x * x;
        }
    }
    var.iter_mut().for_each(|v| *v = (*v / n).max(VAR_FLOOR));

    // pitch on a subset of the speech frames
    let step = (keep.len() / 300).max(1);
    let mut f0s = vec![];
    for &i in keep.iter().step_by(step) {
        let c = starts[i] + FRAME / 2;
        let from = c.saturating_sub(320);
        if from + 640 > audio.len() {
            continue;
        }
        if let Some(f0) = pitch(&audio[from..from + 640]) {
            f0s.push(f0.ln());
        }
    }
    let (log_f0, log_f0_var) = if f0s.len() >= 10 {
        // median-centred to shrug off octave errors
        let mut s = f0s.clone();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let med = s[s.len() / 2];
        let inl: Vec<f32> = s.into_iter().filter(|v| (v - med).abs() < 0.45).collect();
        let m = inl.iter().sum::<f32>() / inl.len() as f32;
        let v = inl.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / inl.len() as f32;
        (m, v.max(1e-4))
    } else {
        (0.0, 0.0)
    };
    Some(Voiceprint {
        mean,
        var,
        log_f0,
        log_f0_var,
        f0_frames: if f0s.len() >= 10 { f0s.len() as u32 } else { 0 },
        frames: keep.len() as u32,
        self_n: 0,
        self_mean: 0.0,
        self_m2: 0.0,
    })
}

/// Autocorrelation pitch estimate (70–400 Hz) of a 40 ms window.
fn pitch(w: &[f32]) -> Option<f32> {
    let n = w.len();
    let mean = w.iter().sum::<f32>() / n as f32;
    let x: Vec<f32> = w.iter().map(|v| v - mean).collect();
    let min_lag = RATE / 400;
    let max_lag = RATE / 70;
    let (mut best, mut best_lag) = (0.0f32, 0usize);
    for lag in min_lag..=max_lag.min(n / 2) {
        let (mut r, mut ea, mut eb) = (0.0f32, 0.0f32, 0.0f32);
        for i in 0..n - lag {
            r += x[i] * x[i + lag];
            ea += x[i] * x[i];
            eb += x[i + lag] * x[i + lag];
        }
        let norm = (ea * eb).sqrt();
        if norm <= 1e-9 {
            continue;
        }
        let r = r / norm;
        // prefer the first strong peak (avoids picking a sub-octave)
        if r > best * 1.08 {
            best = r;
            best_lag = lag;
        }
    }
    (best > 0.5 && best_lag > 0).then(|| RATE as f32 / best_lag as f32)
}

fn hz_to_mel(f: f32) -> f32 {
    2595.0 * (1.0 + f / 700.0).log10()
}
fn mel_to_hz(m: f32) -> f32 {
    700.0 * (10f32.powf(m / 2595.0) - 1.0)
}

/// Triangular mel filters as sparse (bin, weight) lists.
fn mel_bank() -> Vec<Vec<(usize, f32)>> {
    let (lo, hi) = (hz_to_mel(60.0), hz_to_mel(7600.0));
    let pts: Vec<f32> = (0..MELS + 2).map(|i| mel_to_hz(lo + (hi - lo) * i as f32 / (MELS + 1) as f32)).collect();
    let bin_hz = RATE as f32 / NFFT as f32;
    (0..MELS)
        .map(|m| {
            let (l, c, r) = (pts[m], pts[m + 1], pts[m + 2]);
            (0..=NFFT / 2)
                .filter_map(|k| {
                    let f = k as f32 * bin_hz;
                    let w = if f > l && f <= c { (f - l) / (c - l) } else if f > c && f < r { (r - f) / (r - c) } else { 0.0 };
                    (w > 0.0).then_some((k, w))
                })
                .collect()
        })
        .collect()
}

/// Minimal in-place radix-2 FFT.
struct Fft {
    n: usize,
    cos: Vec<f32>,
    sin: Vec<f32>,
}

impl Fft {
    fn new(n: usize) -> Self {
        debug_assert!(n.is_power_of_two());
        let cos = (0..n / 2).map(|i| (std::f32::consts::TAU * i as f32 / n as f32).cos()).collect();
        let sin = (0..n / 2).map(|i| -(std::f32::consts::TAU * i as f32 / n as f32).sin()).collect();
        Self { n, cos, sin }
    }

    fn run(&self, re: &mut [f32], im: &mut [f32]) {
        let n = self.n;
        let mut j = 0;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j |= bit;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let step = n / len;
            for start in (0..n).step_by(len) {
                for k in 0..len / 2 {
                    let (wr, wi) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (start + k, start + k + len / 2);
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            len <<= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Crude vowel-like voice: a glottal pulse train through two formant resonators.
    fn voice(f0: f32, formants: [(f32, f32); 3], secs: f32, seed: u32) -> Vec<f32> {
        let n = (RATE as f32 * secs) as usize;
        let mut rng = seed.wrapping_mul(2_654_435_761).max(1);
        let mut noise = || {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            (rng as f32 / u32::MAX as f32) - 0.5
        };
        let mut src = vec![0.0f32; n];
        let mut phase = 0.0f32;
        for (i, s) in src.iter_mut().enumerate() {
            // slow natural pitch drift and syllable-like amplitude envelope
            let t = i as f32 / RATE as f32;
            let f = f0 * (1.0 + 0.06 * (t * 3.1 + seed as f32).sin());
            phase += f / RATE as f32;
            let env = 0.55 + 0.45 * (t * 4.0 * std::f32::consts::PI).sin().abs();
            if phase >= 1.0 {
                phase -= 1.0;
                *s = env;
            }
            *s += noise() * 0.02;
        }
        let mut out = src;
        for &(fc, bw) in &formants {
            let r = (-std::f32::consts::PI * bw / RATE as f32).exp();
            let th = std::f32::consts::TAU * fc / RATE as f32;
            let (a1, a2) = (2.0 * r * th.cos(), -r * r);
            let (mut y1, mut y2) = (0.0f32, 0.0f32);
            for v in out.iter_mut() {
                let y = *v + a1 * y1 + a2 * y2;
                y2 = y1;
                y1 = y;
                *v = y;
            }
        }
        let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs())).max(1e-6);
        out.iter().map(|v| v / peak * 0.5).collect()
    }

    const ALEX: [(f32, f32); 3] = [(700.0, 90.0), (1200.0, 110.0), (2600.0, 160.0)];
    const SAM: [(f32, f32); 3] = [(420.0, 70.0), (2000.0, 120.0), (3100.0, 200.0)];

    #[test]
    fn fft_matches_dft() {
        let fft = Fft::new(16);
        let x: Vec<f32> = (0..16).map(|i| ((i * 7) % 5) as f32 - 2.0).collect();
        let (mut re, mut im) = (x.clone(), vec![0.0; 16]);
        fft.run(&mut re, &mut im);
        for k in 0..16 {
            let (mut r, mut i) = (0.0f32, 0.0f32);
            for (n, v) in x.iter().enumerate() {
                let a = -std::f32::consts::TAU * (k * n) as f32 / 16.0;
                r += v * a.cos();
                i += v * a.sin();
            }
            assert!((re[k] - r).abs() < 1e-3 && (im[k] - i).abs() < 1e-3);
        }
    }

    #[test]
    #[ignore]
    fn debug_synthetic() {
        let v = voice(140.0, ALEX, 2.0, 1);
        let peak = v.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        let rms = (v.iter().map(|x| x * x).sum::<f32>() / v.len() as f32).sqrt();
        eprintln!("len {} peak {peak} rms {rms} nan {}", v.len(), v.iter().any(|x| !x.is_finite()));
    }

    #[test]
    fn pitch_is_estimated() {
        let v = voice(140.0, ALEX, 2.0, 1);
        let p = extract(&v).unwrap();
        let hz = p.log_f0.exp();
        assert!((hz - 140.0).abs() < 20.0, "pitch {hz}");
    }

    #[test]
    fn too_little_speech_gives_no_print() {
        assert!(extract(&vec![0.0; RATE * 2]).is_none());
        assert!(extract(&voice(120.0, ALEX, 0.4, 1)).is_none());
    }

    #[test]
    fn same_voice_is_closer_than_different_voice() {
        let a1 = extract(&voice(120.0, ALEX, 2.5, 1)).unwrap();
        let a2 = extract(&voice(124.0, ALEX, 3.0, 7)).unwrap();
        let b = extract(&voice(215.0, SAM, 2.5, 3)).unwrap();
        let same = distance(&a1, &a2);
        let diff = distance(&a1, &b);
        assert!(same < diff / 3.0, "same {same} diff {diff}");
        let t = base_threshold(0.5);
        assert_ne!(verdict(diff, t), Verdict::Match);
        assert_eq!(verdict(same, t), Verdict::Match);
    }

    #[test]
    fn merging_moves_profile_and_keeps_shape() {
        let mut p = extract(&voice(120.0, ALEX, 2.5, 1)).unwrap();
        let q = extract(&voice(126.0, ALEX, 2.5, 9)).unwrap();
        let before = p.frames;
        p.merge(&q);
        assert_eq!(p.frames, before + q.frames);
        assert!(p.var.iter().all(|v| *v >= VAR_FLOOR));
        assert!(distance(&p, &q) < 1.0);
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(serde_json::from_str::<Voiceprint>(&json).unwrap(), p);
    }

    #[test]
    fn threshold_adapts_to_own_variation() {
        let mut p = extract(&voice(120.0, ALEX, 2.5, 1)).unwrap();
        assert_eq!(p.threshold(0.4), 0.4);
        for d in [0.1, 0.12, 0.15, 0.11, 0.13] {
            p.observe_self_distance(d);
        }
        let t = p.threshold(0.4);
        assert!(t < 0.4 && t >= 0.4 * 0.8, "t {t}");
    }

    /// Calibration against real recordings: `SPEAKER_DIR=/path/with/<speaker>_<n>.wav
    /// cargo test --lib calibrate -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn calibrate_on_recordings() {
        use std::collections::BTreeMap;
        let Ok(dir) = std::env::var("SPEAKER_DIR") else { return };
        let mut by: BTreeMap<String, Vec<Voiceprint>> = BTreeMap::new();
        let mut paths: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        paths.sort();
        for p in paths {
            let name = p.file_stem().unwrap().to_string_lossy().to_string();
            let spk = name.split('_').next().unwrap().to_string();
            let mut r = hound::WavReader::open(&p).unwrap();
            let rate = r.spec().sample_rate;
            let raw: Vec<f32> = r.samples::<i16>().map(|v| v.unwrap() as f32 / 32768.0).collect();
            let a = crate::voice::capture::prepare_for_stt(&crate::voice::capture::resample_to_16k(&raw, rate));
            if let Some(vp) = extract(&a) {
                by.entry(spk).or_default().push(vp);
            }
        }
        let spks: Vec<&String> = by.keys().collect();
        eprintln!("{} speakers", spks.len());
        if let Ok(out) = std::env::var("DUMP") {
            std::fs::write(out, serde_json::to_string(&by).unwrap()).unwrap();
        }
        // utterance-to-utterance distances
        let (mut same, mut diff) = (vec![], vec![]);
        for (i, a) in spks.iter().enumerate() {
            for (j, b) in spks.iter().enumerate() {
                for (x, pa) in by[*a].iter().enumerate() {
                    for (y, pb) in by[*b].iter().enumerate() {
                        if i == j && x < y {
                            same.push(distance(pa, pb));
                        } else if i < j && x == 0 && y == 0 {
                            diff.push(distance(pa, pb));
                        }
                    }
                }
            }
        }
        let q = |v: &mut Vec<f32>, p: f32| {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v[((v.len() - 1) as f32 * p) as usize]
        };
        eprintln!(
            "utt-utt same: p10 {:.2} p50 {:.2} p90 {:.2} p97 {:.2} | diff: p3 {:.2} p10 {:.2} p50 {:.2}",
            q(&mut same, 0.1),
            q(&mut same, 0.5),
            q(&mut same, 0.9),
            q(&mut same, 0.97),
            q(&mut diff, 0.03),
            q(&mut diff, 0.1),
            q(&mut diff, 0.5)
        );
        // enrolled profiles: utterances 0..k learned, the rest tested
        let bases: Vec<f32> = match std::env::var("SWEEP") {
            Ok(_) => vec![0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5],
            Err(_) => [0.0f32, 0.3, 0.5, 0.7, 1.0].iter().map(|s| base_threshold(*s)).collect(),
        };
        for base in bases {
            for k in [1usize, 3] {
                let mut profiles: Vec<(String, Voiceprint)> = vec![];
                for s in &spks {
                    let mut p = by[*s][0].clone();
                    for u in by[*s].iter().take(k).skip(1) {
                        let d = distance(u, &p);
                        p.observe_self_distance(d);
                        p.merge(u);
                    }
                    profiles.push(((*s).clone(), p));
                }
                let (mut own_total, mut own_unknown, mut own_match) = (0, 0, 0);
                let (mut other_total, mut other_unknown) = (0, 0);
                for (i, (s, prof)) in profiles.iter().enumerate() {
                    for u in by[s].iter().skip(k) {
                        own_total += 1;
                        match verdict(distance(u, prof), prof.threshold(base)) {
                            Verdict::Unknown => own_unknown += 1,
                            Verdict::Match => own_match += 1,
                            _ => {}
                        }
                    }
                    // a stranger talking while only this person is enrolled
                    for (j, (s2, _)) in profiles.iter().enumerate() {
                        if i == j {
                            continue;
                        }
                        let u = by[s2].last().unwrap();
                        other_total += 1;
                        if verdict(distance(u, prof), prof.threshold(base)) == Verdict::Unknown {
                            other_unknown += 1;
                        }
                    }
                }
                eprintln!(
                    "threshold {base:.2}, enrolled {k}: owner recognised {:.1}% (clear {:.1}%) | stranger caught {:.1}%",
                    100.0 * (own_total - own_unknown) as f32 / own_total as f32,
                    100.0 * own_match as f32 / own_total as f32,
                    100.0 * other_unknown as f32 / other_total as f32
                );
            }
        }
    }
}
