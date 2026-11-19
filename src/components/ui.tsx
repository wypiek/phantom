import { useEffect, useRef, useState, type ReactNode } from 'react';
import { prettyShortcut } from '../lib/shortcuts';

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Field({ label, hint, children, inline }: { label: ReactNode; hint?: ReactNode; children: ReactNode; inline?: boolean }) {
  return (
    <div className={`field ${inline ? 'field-inline' : ''}`}>
      <div className="field-head">
        <div className="field-label">{label}</div>
        {hint && <div className="field-hint">{hint}</div>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  format,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  label?: string;
}) {
  return (
    <div className="slider">
      <input aria-label={label} className="range" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-value mono">{format ? format(value) : value}</span>
    </div>
  );
}

export function Section({ title, children, aside, description }: { title: string; children: ReactNode; aside?: ReactNode; description?: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2 className="section-title">{title}</h2>
          {description && <div className="section-desc">{description}</div>}
        </div>
        {aside}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

/** Pill-shaped status: green ok, red problem, neutral otherwise. */
export function Status({ tone, children }: { tone: 'ok' | 'bad' | 'warn' | 'idle'; children: ReactNode }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}

/** A row of mutually exclusive options that looks like one control. */
export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.id)} type="button" role="radio" aria-checked={o.id === value} className={o.id === value ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const ICONS: Record<string, ReactNode> = {
  home: <path d="M2.5 7.5 8 3l5.5 4.5V13.5h-3.5v-3.5h-4v3.5H2.5z" />,
  general: (
    <>
      <path d="M2 4.5h12M2 11.5h12" />
      <circle cx="5.5" cy="4.5" r="1.6" fill="var(--icon-fill)" />
      <circle cx="10.5" cy="11.5" r="1.6" fill="var(--icon-fill)" />
    </>
  ),
  provider: (
    <>
      <path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4M3.6 3.6l1.7 1.7M10.7 10.7l1.7 1.7M3.6 12.4l1.7-1.7M10.7 5.3l1.7-1.7" />
      <circle cx="8" cy="8" r="2.2" />
    </>
  ),
  personality: (
    <>
      <path d="M3 14V7.2a5 5 0 0 1 10 0V14l-1.7-1.3L9.6 14 8 12.7 6.4 14l-1.7-1.3z" />
      <path d="M6.2 7v1.2M9.8 7v1.2" />
    </>
  ),
  computer: <path d="M3.5 2.5 12 7.2l-3.8 1.3-1.6 3.9z" />,
  voice: (
    <>
      <rect x="6" y="1.8" width="4" height="7.6" rx="2" />
      <path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2.2" />
    </>
  ),
  appearance: (
    <>
      <path d="M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  history: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8l2.4 1.5" />
    </>
  ),
  privacy: (
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" />
    </>
  ),
  about: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v4M8 4.9v.2" />
    </>
  ),
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  arrow: <path d="M6 3.5 10.5 8 6 12.5" />,
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name] ?? null}
    </svg>
  );
}

/** Text input that commits on blur/Enter instead of every keystroke. */
export function CommitInput({ value, onCommit, placeholder, mono, type = 'text' }: { value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean; type?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={`input ${mono ? 'mono' : ''}`}
      type={type}
      value={v}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** Records a keyboard shortcut in Tauri accelerator format. */
export function ShortcutInput({ value, onChange, allowModifierOnly }: { value: string; onChange: (v: string) => void; allowModifierOnly?: boolean }) {
  const [recording, setRecording] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!recording) return;
    let loneModifier: string | null = null;
    const onUp = (e: KeyboardEvent) => {
      if (allowModifierOnly && loneModifier && e.code === loneModifier) {
        onChange(loneModifier);
        setRecording(false);
      }
      loneModifier = null;
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') return setRecording(false);
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
        if (e.repeat) return;
        // a modifier pressed alone (and released alone) becomes the shortcut
        loneModifier = loneModifier === null ? e.code : '';
        return;
      }
      loneModifier = '';
      const parts: string[] = [];
      if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      const code = e.code;
      let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (code.startsWith('Key')) key = code.slice(3);
      else if (code.startsWith('Digit')) key = code.slice(5);
      else if (code === 'Space') key = 'Space';
      parts.push(key);
      if (parts.length < 2 && !/^F\d+$/.test(key)) return; // require a modifier
      onChange(parts.join('+'));
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, [recording, onChange, allowModifierOnly]);
  const pretty = prettyShortcut(value);
  return (
    <div className="row">
      <button ref={ref} type="button" className={`btn small shortcut ${recording ? 'recording' : ''}`} onClick={() => setRecording(true)}>
        {recording ? (allowModifierOnly ? 'Press a key or combo… (Esc cancels)' : 'Press keys… (Esc to cancel)') : pretty || 'Not set'}
      </button>
      {value && !recording && (
        <button type="button" className="btn ghost small" onClick={() => onChange('')}>
          Clear
        </button>
      )}
    </div>
  );
}

export function Modal({ title, children, onClose, actions }: { title: string; children: ReactNode; onClose?: () => void; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal crt" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-title">
          <span className="label-pill">{title}</span>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Tiny pixel sprite from the UI atlas (bubble, heart, faces…). */
export function UiSprite({ name, scale = 1, className }: { name: string; scale?: number; className?: string }) {
  const [map, setMap] = useState<Record<string, { x: number; y: number; w: number; h: number }> | null>(uiCache);
  useEffect(() => {
    if (!uiCache) void fetch('/sprites/ui-atlas.json').then((r) => r.json()).then((j) => {
      uiCache = j.items;
      uiWidth = j.width;
      setMap(j.items);
    });
  }, []);
  const r = map?.[name];
  if (!r) return <span style={{ display: 'inline-block', width: 20 * scale, height: 20 * scale }} />;
  return (
    <span
      className={`pixel ${className ?? ''}`}
      style={{
        display: 'inline-block',
        width: r.w * scale,
        height: r.h * scale,
        backgroundImage: 'url(/sprites/ui-atlas.png)',
        backgroundPosition: `-${r.x * scale}px -${r.y * scale}px`,
        backgroundSize: `${uiWidth * scale}px auto`,
        imageRendering: 'pixelated',
      }}
    />
  );
}
let uiCache: Record<string, { x: number; y: number; w: number; h: number }> | null = null;
let uiWidth = 380;

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e) => alive && setState({ data: null, error: typeof e === 'string' ? e : String(e?.message ?? e), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}
