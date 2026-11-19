import { emit, listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import { ShortcutInput, Slider, Toggle, useAsync } from '../components/ui';
import { api } from '../lib/ipc';
import { prettyShortcut } from '../lib/shortcuts';
import type { Settings } from '../lib/types';

type Update = (m: (d: Settings) => void) => Promise<string[]>;

/**
 * Hold-to-talk microphone button with the push-to-talk keybind on it, plus a
 * popover for microphone input settings. In continuous mode the button
 * switches listening on/off instead.
 */
export function MicControl({ settings, update }: { settings: Settings; update: Update }) {
  const [listening, setListening] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const continuous = settings.voice.mode === 'continuous';
  const key = prettyShortcut(settings.general.shortcuts.pushToTalk);

  useEffect(() => {
    const un = listen<{ listening: boolean; phase: string }>('voice://state', ({ payload }) => {
      setListening(payload.listening);
      setPhase(payload.phase);
    });
    return () => void un.then((f) => f());
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !settings.voice.enabled) return;
    if (continuous) {
      void emit('voice://request', { action: 'continuous-toggle' });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    heldRef.current = true;
    setHeld(true);
    void emit('voice://request', { action: 'start' });
  };
  const up = () => {
    if (!heldRef.current) return;
    heldRef.current = false;
    setHeld(false);
    void emit('voice://request', { action: 'stop' });
  };

  const live = held || listening;
  const label = !settings.voice.enabled
    ? 'MIC OFF'
    : phase === 'transcribing'
      ? 'DECODING'
      : continuous
        ? listening
          ? 'LISTENING'
          : 'MIC PAUSED'
        : live
          ? 'RELEASE TO SEND'
          : 'HOLD TO TALK';

  return (
    <div className="mic-control" ref={wrap}>
      <button
        type="button"
        className={`ptt ${live ? 'live' : ''} ${!settings.voice.enabled ? 'off' : ''}`}
        onPointerDown={down}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={up}
        disabled={!settings.voice.enabled}
        title={continuous ? 'Continuous listening — click to pause or resume' : `Hold to talk (or hold ${key} anywhere)`}
        aria-label={continuous ? 'Toggle continuous listening' : 'Hold to talk'}
      >
        <MicGlyph />
        <span className="ptt-text">
          <span className="ptt-label">{label}</span>
          {!continuous && key && <span className="ptt-key">{key}</span>}
        </span>
      </button>
      <button type="button" className={`ptt-more ${open ? 'open' : ''}`} aria-label="Microphone settings" aria-expanded={open} onClick={() => setOpen(!open)}>
        ▾
      </button>
      {open && <MicPopover settings={settings} update={update} />}
    </div>
  );
}

function MicPopover({ settings, update }: { settings: Settings; update: Update }) {
  const devices = useAsync(() => api.voiceDevices(), []);
  const models = useAsync(() => api.voiceModels(), []);
  const [level, setLevel] = useState(0);
  const v = settings.voice;
  const model = models.data?.find((m) => m.name === v.whisperModel);

  useEffect(() => {
    const un = listen<number>('voice://level', ({ payload }) => setLevel(payload));
    return () => void un.then((f) => f());
  }, []);

  return (
    <div className="mic-pop crt" role="dialog" aria-label="Microphone settings">
      <div className="mic-pop-title">// INPUT</div>

      <label className="mic-row">
        <span>Voice input</span>
        <Toggle checked={v.enabled} onChange={(x) => void update((d) => void (d.voice.enabled = x))} />
      </label>

      <div className="mic-field">
        <span className="mic-field-label">Microphone</span>
        <select className="select" value={v.inputDevice} onChange={(e) => void update((d) => void (d.voice.inputDevice = e.target.value))}>
          <option value="">System default</option>
          {devices.data?.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
              {d.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </select>
        {devices.error && <div className="mic-err">{devices.error}</div>}
      </div>

      <div className="mic-field">
        <span className="mic-field-label">Input gain</span>
        <Slider value={v.inputGain} min={0.25} max={4} step={0.05} onChange={(x) => void update((d) => void (d.voice.inputGain = x))} format={(x) => `${x.toFixed(2)}×`} label="Input gain" />
        <div className="mic-meter" aria-label="Input level">
          <div style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
        <span className="mic-hint">Hold to talk to see the level.</span>
      </div>

      <div className="mic-field">
        <span className="mic-field-label">Mode</span>
        <div className="mic-seg">
          <button className={v.mode === 'push-to-talk' ? 'on' : ''} onClick={() => void update((d) => void (d.voice.mode = 'push-to-talk'))}>
            Push to talk
          </button>
          <button className={v.mode === 'continuous' ? 'on' : ''} onClick={() => void update((d) => void (d.voice.mode = 'continuous'))}>
            Continuous
          </button>
        </div>
      </div>

      <div className="mic-field">
        <span className="mic-field-label">Push-to-talk key</span>
        <ShortcutInput value={settings.general.shortcuts.pushToTalk} onChange={(x) => void update((d) => void (d.general.shortcuts.pushToTalk = x))} />
      </div>

      <label className="mic-row">
        <span>Confirm before sending</span>
        <Toggle checked={v.confirmBeforeSend} onChange={(x) => void update((d) => void (d.voice.confirmBeforeSend = x))} />
      </label>

      <div className="mic-foot">
        <span className={model?.downloaded ? 'ok' : 'warn'}>
          whisper:{v.whisperModel} {model ? (model.downloaded ? '· ready' : '· not downloaded') : ''}
        </span>
        <button className="btn ghost small" onClick={() => void api.openWindow('settings', 'voice')}>
          All voice settings →
        </button>
      </div>
    </div>
  );
}

function MicGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden shapeRendering="crispEdges">
      <rect x="6" y="1" width="4" height="8" />
      <rect x="5" y="2" width="1" height="6" />
      <rect x="10" y="2" width="1" height="6" />
      <rect x="3" y="7" width="1" height="2" />
      <rect x="12" y="7" width="1" height="2" />
      <rect x="4" y="9" width="1" height="1" />
      <rect x="11" y="9" width="1" height="1" />
      <rect x="5" y="10" width="6" height="1" />
      <rect x="7" y="11" width="2" height="3" />
      <rect x="5" y="14" width="6" height="1" />
    </svg>
  );
}
