import { emitTo, listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import { CommitInput, Field, Section, Segmented, Slider, Toggle, useAsync } from '../../components/ui';
import { prettyShortcut } from '../../lib/shortcuts';
import { FX_LIMITS, PRESETS, presetById, resolveFx } from '../../audio/presets';
import { api, errorText } from '../../lib/ipc';
import type { FxParams, Settings, WhisperModel } from '../../lib/types';

type Props = { s: Settings; update: (m: (d: Settings) => void) => Promise<string[]> };

const LANGS: [string, string][] = [
  ['en', 'English'],
  ['de', 'German'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['it', 'Italian'],
  ['pl', 'Polish'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ja', 'Japanese'],
  ['auto', 'Auto-detect'],
];

export function useModelDownloads(reload: () => void) {
  const [progress, setProgress] = useState<Record<string, { received: number; total: number | null; error?: string | null }>>({});
  useEffect(() => {
    const un = listen<{ name: string; received: number; total: number | null; done: boolean; error: string | null }>('voice://model-progress', ({ payload: p }) => {
      setProgress((x) => ({ ...x, [p.name]: { received: p.received, total: p.total, error: p.error } }));
      if (p.done) {
        reload();
        if (!p.error) setProgress((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== p.name)));
      }
    });
    return () => void un.then((f) => f());
  }, [reload]);
  return progress;
}

export function WhisperModels({ s, update }: Props) {
  const models = useAsync(() => api.voiceModels(), []);
  const progress = useModelDownloads(models.reload);
  const [err, setErr] = useState<string | null>(null);
  const download = (m: WhisperModel) => {
    setErr(null);
    api.voiceDownloadModel(m.name).catch((e) => setErr(errorText(e)));
    setTimeout(models.reload, 100);
  };
  return (
    <div className="model-table">
      {models.data?.map((m) => {
        const p = progress[m.name];
        const pct = p?.total ? Math.round((p.received / p.total) * 100) : null;
        const selected = s.voice.whisperModel === m.name;
        return (
          <div key={m.name} className={`model-item ${selected ? 'selected' : ''}`}>
            <label className="row grow">
              <input type="radio" name="whisper" checked={selected} onChange={() => void update((d) => void (d.voice.whisperModel = m.name))} />
              <div className="grow">
                <div className="mono">{m.name}</div>
                <div className="faint small-text">
                  {m.description} · {m.sizeMb} MB
                </div>
              </div>
            </label>
            {m.downloaded ? (
              <div className="row">
                <span className="label-pill ok">ready</span>
                <button className="btn ghost small" onClick={() => void api.voiceDeleteModel(m.name).then(models.reload)}>
                  Delete
                </button>
              </div>
            ) : m.downloading || p ? (
              <div className="row">
                <div className="progress">
                  <div style={{ width: `${pct ?? 5}%` }} />
                </div>
                <span className="mono small-text">{pct != null ? `${pct}%` : '…'}</span>
              </div>
            ) : (
              <button className="btn small" onClick={() => download(m)}>
                Download
              </button>
            )}
          </div>
        );
      })}
      {err && <div className="notice error">{err}</div>}
      <div className="faint small-text">Models download from huggingface.co (ggerganov/whisper.cpp) into PHANTOM's data folder. Speech is transcribed on this computer; audio is never uploaded.</div>
    </div>
  );
}

export function MicTest() {
  const [state, setState] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  const [level, setLevel] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const un = listen<number>('voice://level', ({ payload }) => setLevel(payload));
    return () => void un.then((f) => f());
  }, []);
  const start = async () => {
    setErr(null);
    setText(null);
    try {
      await api.voiceStart('push-to-talk');
      setState('listening');
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const stop = async () => {
    setState('transcribing');
    try {
      const r = await api.voiceStop();
      setText(r.text || '(silence)');
    } catch (e) {
      setErr(errorText(e));
    }
    setState('idle');
  };
  return (
    <div className="mic-test">
      <div className="row">
        {state === 'idle' ? (
          <button className="btn" onClick={() => void start()}>
            Test microphone
          </button>
        ) : (
          <button className="btn primary" onClick={() => void stop()} disabled={state === 'transcribing'}>
            {state === 'transcribing' ? 'Transcribing…' : 'Stop & transcribe'}
          </button>
        )}
        <div className="level-meter" aria-label="Microphone level">
          <div style={{ width: `${state === 'listening' ? Math.round(level * 100) : 0}%` }} />
        </div>
      </div>
      {state === 'listening' && <div className="faint small-text">Say something, then press stop.</div>}
      {text && (
        <div className="notice ok" style={{ marginTop: 6 }}>
          Heard: “{text}”
        </div>
      )}
      {err && <div className="notice error" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

export function VoiceSection({ s, update }: Props) {
  const [tab, setTab] = useState<'hearing' | 'speaking' | 'effects'>('hearing');
  return (
    <>
      <div className="tabbar">
        <Segmented
          label="Voice settings"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'hearing', label: 'Hearing you' },
            { id: 'speaking', label: "Noli's voice" },
            { id: 'effects', label: 'Effects' },
          ]}
        />
      </div>
      {tab === 'hearing' && <HearingSection s={s} update={update} />}
      {tab !== 'hearing' && <TtsSection s={s} update={update} part={tab} />}
    </>
  );
}

function HearingSection({ s, update }: Props) {
  const v = s.voice;
  const devices = useAsync(() => api.voiceDevices(), []);
  return (
    <>
      <Section title="Speech recognition">
        <Field label="Voice input" hint="Turn off to disable the microphone completely." inline>
          <Toggle checked={v.enabled} onChange={(x) => void update((d) => void (d.voice.enabled = x))} />
        </Field>
        <Field label="Engine" hint="Whisper runs locally via whisper.cpp (GPU-accelerated on Apple Silicon).">
          <select className="select" value={v.sttEngine} onChange={(e) => void update((d) => void (d.voice.sttEngine = e.target.value))}>
            <option value="whisper">Whisper (local, offline)</option>
          </select>
        </Field>
        <Field label="Model">
          <WhisperModels s={s} update={update} />
        </Field>
        <Field label="Language">
          <select className="select" value={v.language} onChange={(e) => void update((d) => void (d.voice.language = e.target.value))}>
            {LANGS.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          {v.language !== 'en' && v.whisperModel.endsWith('.en') && <div className="notice" style={{ marginTop: 6 }}>The selected model is English-only. Choose "base" or "small" for other languages.</div>}
        </Field>
        <Field label="Microphone">
          <select className="select" value={v.inputDevice} onChange={(e) => void update((d) => void (d.voice.inputDevice = e.target.value))}>
            <option value="">System default</option>
            {devices.data?.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
                {d.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
          {devices.error && <div className="notice error">{devices.error}</div>}
        </Field>
        <Field label="Accurate transcription" hint="Searches several possible transcriptions before deciding (beam search). Noticeably better with names and accents; about twice the work. Live previews stay fast." inline>
          <Toggle checked={v.accurateTranscription} onChange={(x) => void update((d) => void (d.voice.accurateTranscription = x))} />
        </Field>
        <Field label="Input gain" hint="Boost a quiet microphone or tame a hot one. Applied before speech detection.">
          <Slider value={v.inputGain} min={0.25} max={4} step={0.05} onChange={(x) => void update((d) => void (d.voice.inputGain = x))} format={(x) => `${x.toFixed(2)}×`} label="Input gain" />
          <MicTest />
        </Field>
      </Section>

      <Section title="Listening">
        <Field label="Mode">
          <div className="radio-list">
            <label className={`radio ${v.mode === 'push-to-talk' ? 'selected' : ''}`}>
              <input type="radio" checked={v.mode === 'push-to-talk'} onChange={() => void update((d) => void (d.voice.mode = 'push-to-talk'))} />
              <div>
                <div>Push to talk</div>
                <div className="faint small-text">Hold {s.general.shortcuts.pushToTalk ? <span className="kbd">{prettyShortcut(s.general.shortcuts.pushToTalk)}</span> : 'the shortcut (not set)'} while you speak, let go to send. The mic is closed otherwise.</div>
              </div>
            </label>
            <label className={`radio ${v.mode === 'continuous' ? 'selected' : ''}`}>
              <input type="radio" checked={v.mode === 'continuous'} onChange={() => void update((d) => void (d.voice.mode = 'continuous'))} />
              <div>
                <div>Continuous listening</div>
                <div className="faint small-text">The mic stays open and Noli answers whenever you speak. Speech is detected and transcribed locally.</div>
              </div>
            </label>
          </div>
        </Field>
        {v.mode === 'continuous' && (
          <Field label="Sensitivity" hint="Higher reacts to quieter speech (and more background noise).">
            <Slider value={v.vadSensitivity} min={0} max={1} step={0.05} onChange={(x) => void update((d) => void (d.voice.vadSensitivity = x))} format={(x) => `${Math.round(x * 100)}%`} label="Sensitivity" />
          </Field>
        )}
        <Field label="Confirm before sending" hint="Show what was heard and wait for Send." inline>
          <Toggle checked={v.confirmBeforeSend} onChange={(x) => void update((d) => void (d.voice.confirmBeforeSend = x))} />
        </Field>
        <Field label="Interrupt by speaking" hint="Talking over Noli stops his voice (continuous mode). Push-to-talk always interrupts." inline>
          <Toggle checked={v.interruptOnSpeech} onChange={(x) => void update((d) => void (d.voice.interruptOnSpeech = x))} />
        </Field>
      </Section>

      <Section title="Who is speaking">
        <Field label="Recognise voices" hint="Noli learns your voice. When someone it doesn't recognise talks, it asks who they are and remembers them. Manage known voices in Privacy & Memory." inline>
          <Toggle checked={v.speakerRecognition} onChange={(x) => void update((d) => void (d.voice.speakerRecognition = x))} />
        </Field>
        {v.speakerRecognition && (
          <Field label="Strictness" hint="Higher asks “who's speaking?” more readily; lower assumes it's someone it knows. If Noli keeps asking you who you are, turn this down.">
            <Slider value={v.speakerStrictness} min={0} max={1} step={0.05} onChange={(x) => void update((d) => void (d.voice.speakerStrictness = x))} format={(x) => `${Math.round(x * 100)}%`} label="Strictness" />
          </Field>
        )}
        {v.speakerRecognition && !s.privacy.memoryEnabled && <div className="notice">Long-term memory is off, so Noli won't remember voices. Turn it on in Privacy & Memory.</div>}
      </Section>
    </>
  );
}

export function preview(text = 'I live in the wires now. Ask me anything… if you dare.') {
  void emitTo('companion', 'tts://request', { action: 'preview', text });
}

export function PresetPicker({ s, update }: Props) {
  const t = s.tts;
  const custom = Object.keys(t.customPresets ?? {});
  return (
    <div className="preset-grid">
      {PRESETS.map((p) => (
        <div key={p.id} className={`preset ${t.preset === p.id && !t.fx ? 'selected' : ''}`}>
          <button className="preset-main" onClick={() => void update((d) => void ((d.tts.preset = p.id), (d.tts.fx = null)))}>
            <div className="preset-name">{p.label}</div>
            <div className="faint small-text">{p.description}</div>
          </button>
          <button
            className="btn ghost small"
            onClick={async () => {
              await update((d) => void ((d.tts.preset = p.id), (d.tts.fx = null)));
              setTimeout(() => preview(), 120);
            }}
          >
            ▶ Preview
          </button>
        </div>
      ))}
      {custom.map((name) => (
        <div key={name} className={`preset ${t.preset === name && !t.fx ? 'selected' : ''}`}>
          <button className="preset-main" onClick={() => void update((d) => void ((d.tts.preset = name), (d.tts.fx = null)))}>
            <div className="preset-name">{name}</div>
            <div className="faint small-text">Your preset</div>
          </button>
          <div className="row">
            <button className="btn ghost small" onClick={() => void update((d) => void ((d.tts.preset = name), (d.tts.fx = null))).then(() => setTimeout(() => preview(), 120))}>
              ▶
            </button>
            <button
              className="btn ghost small"
              onClick={() =>
                void update((d) => {
                  delete d.tts.customPresets[name];
                  if (d.tts.preset === name) d.tts.preset = 'phantom';
                })
              }
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function TtsSection({ s, update, part }: Props & { part: 'speaking' | 'effects' }) {
  const t = s.tts;
  const status = useAsync(() => api.ttsStatus(), [t.piperPath]);
  const voices = useAsync(() => api.ttsVoices(), []);
  const piperVoices = useAsync(() => api.ttsPiperVoices(), []);
  const fx = resolveFx(t.preset, t.fx, t.customPresets ?? {});
  const [sample, setSample] = useState('I live in the wires now. Ask me anything… if you dare.');
  const [presetName, setPresetName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const setFx = (k: keyof FxParams, val: number) => void update((d) => void (d.tts.fx = { ...fx, [k]: val }));
  const english = (voices.data ?? []).filter((v) => v.language.startsWith('en'));
  const others = (voices.data ?? []).filter((v) => !v.language.startsWith('en'));

  if (part === 'speaking')
    return (
    <>
      <Section title="Noli's voice">
        <Field label="Speak replies" hint="Replies are spoken sentence by sentence while they are written." inline>
          <Toggle checked={t.enabled} onChange={(x) => void update((d) => void (d.tts.enabled = x))} />
        </Field>
        <Field label="Speech engine">
          <div className="radio-list">
            <label className={`radio ${t.engine === 'system' ? 'selected' : ''}`}>
              <input type="radio" checked={t.engine === 'system'} onChange={() => void update((d) => void (d.tts.engine = 'system'))} />
              <div>
                <div>{status.data?.systemEngine ?? 'System voice'}</div>
                <div className="faint small-text">{status.data?.systemAvailable === false ? 'Not available — install espeak-ng.' : 'Built in, offline, instant.'}</div>
              </div>
            </label>
            <label className={`radio ${t.engine === 'piper' ? 'selected' : ''}`}>
              <input type="radio" checked={t.engine === 'piper'} onChange={() => void update((d) => void (d.tts.engine = 'piper'))} />
              <div>
                <div>Piper (local neural TTS)</div>
                <div className="faint small-text">{status.data?.piperPath ? `Found ${status.data.piperPath}` : 'Not installed. Install with `pipx install piper-tts` or set the path below.'}</div>
              </div>
            </label>
          </div>
        </Field>
        {t.engine === 'system' && (
          <Field label="System voice" hint="Leave on “Preset default” to let each preset pick a fitting voice.">
            <select className="select" value={t.systemVoice} onChange={(e) => void update((d) => void (d.tts.systemVoice = e.target.value))}>
              <option value="">Preset default ({presetById(t.preset)?.voiceHint[0] ?? 'system'})</option>
              <optgroup label="English">
                {english.map((v) => (
                  <option key={v.id} value={v.name}>
                    {v.name} · {v.language}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Other languages">
                {others.map((v) => (
                  <option key={v.id} value={v.name}>
                    {v.name} · {v.language}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
        )}
        {t.engine === 'piper' && (
          <>
            <Field label="Piper executable" hint="Empty = auto-detect on PATH.">
              <CommitInput value={t.piperPath} mono placeholder={status.data?.piperPath ?? '/path/to/piper'} onCommit={(v) => void update((d) => void (d.tts.piperPath = v.trim()))} />
            </Field>
            <Field label="Piper voice">
              <div className="model-table">
                {piperVoices.data?.map((pv) => (
                  <div key={pv.id} className={`model-item ${t.piperModel === pv.id ? 'selected' : ''}`}>
                    <label className="row grow">
                      <input type="radio" disabled={!pv.downloaded} checked={t.piperModel === pv.id} onChange={() => void update((d) => void (d.tts.piperModel = pv.id))} />
                      <div className="grow">
                        <div className="mono">{pv.id}</div>
                        <div className="faint small-text">
                          {pv.description} · {pv.sizeMb} MB
                        </div>
                      </div>
                    </label>
                    {pv.downloaded ? (
                      <span className="label-pill ok">ready</span>
                    ) : (
                      <button
                        className="btn small"
                        disabled={busy === pv.id}
                        onClick={async () => {
                          setBusy(pv.id);
                          setErr(null);
                          try {
                            await api.ttsDownloadPiperVoice(pv.id);
                            piperVoices.reload();
                            status.reload();
                          } catch (e) {
                            setErr(errorText(e));
                          }
                          setBusy(null);
                        }}
                      >
                        {busy === pv.id ? <span className="spinner" /> : 'Download'}
                      </button>
                    )}
                  </div>
                ))}
                {err && <div className="notice error">{err}</div>}
              </div>
            </Field>
          </>
        )}
        <Field label="Preview">
          <div className="row">
            <input className="input" value={sample} onChange={(e) => setSample(e.target.value)} />
            <button className="btn primary" onClick={() => preview(sample)}>
              ▶ Speak
            </button>
            <button className="btn ghost" onClick={() => void emitTo('companion', 'tts://request', { action: 'stop' })}>
              Stop
            </button>
          </div>
        </Field>
      </Section>

      <Section title="Voice presets" description="Each preset is a voice plus an effects chain. Tweak it under Effects.">
        <PresetPicker s={s} update={update} />
      </Section>
    </>
    );

  return (
    <>
      <Section
        title="Audio effects"
        aside={
          <div className="row">
            {t.fx && (
              <button className="btn ghost small" onClick={() => void update((d) => void (d.tts.fx = null))}>
                Reset to preset
              </button>
            )}
            <button className="btn small" onClick={() => preview(sample)}>
              ▶ Preview
            </button>
          </div>
        }
      >
        <p className="dim section-note">Effects are applied live. Keep them subtle enough that speech stays clear.</p>
        <div className="fx-grid">
          {(Object.keys(FX_LIMITS) as (keyof FxParams)[]).map((k) => {
            const lim = FX_LIMITS[k];
            return (
              <Field key={k} label={lim.label}>
                <Slider
                  value={fx[k]}
                  min={lim.min}
                  max={lim.max}
                  step={lim.step}
                  onChange={(v) => setFx(k, v)}
                  label={lim.label}
                  format={(v) => (lim.unit === 'Hz' ? `${Math.round(v)} Hz` : lim.unit === '×' ? `${v.toFixed(2)}×` : lim.unit === 's' ? `${v.toFixed(2)}s` : `${Math.round(v * 100)}%`)}
                />
              </Field>
            );
          })}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <input className="input" placeholder="Name this voice…" value={presetName} onChange={(e) => setPresetName(e.target.value)} style={{ maxWidth: 240 }} />
          <button
            className="btn"
            disabled={!presetName.trim() || PRESETS.some((p) => p.id === presetName.trim().toLowerCase())}
            onClick={() => {
              const name = presetName.trim();
              void update((d) => {
                d.tts.customPresets = { ...(d.tts.customPresets ?? {}), [name]: fx };
                d.tts.preset = name;
                d.tts.fx = null;
              });
              setPresetName('');
            }}
          >
            Save as preset
          </button>
        </div>
      </Section>
    </>
  );
}
