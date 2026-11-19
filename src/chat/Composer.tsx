import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../lib/types';
import { MicControl } from './MicControl';

type Update = (m: (d: Settings) => void) => Promise<string[]>;

/** Terminal-style prompt line with the hold-to-talk mic and live transcript. */
export function Composer({ onSend, onStop, running, settings, update }: { onSend: (t: string) => Promise<boolean>; onStop: () => void; running: boolean; settings: Settings | null; update: Update }) {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [partial, setPartial] = useState('');
  const [level, setLevel] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let clear: ReturnType<typeof setTimeout>;
    const subs = [
      listen<{ listening: boolean; phase: string }>('voice://state', ({ payload }) => {
        setListening(payload.listening);
        setPhase(payload.phase);
        clearTimeout(clear);
        if (!payload.listening && payload.phase === 'idle') clear = setTimeout(() => setPartial(''), 1800);
        if (payload.listening && payload.phase !== 'transcribing') setPartial('');
      }),
      listen<{ text: string }>('voice://partial', ({ payload }) => setPartial(payload.text)),
      listen<{ text: string }>('voice://final', ({ payload }) => setPartial(payload.text)),
      listen<number>('voice://level', ({ payload }) => setLevel(payload)),
    ];
    return () => {
      clearTimeout(clear);
      subs.forEach((s) => void s.then((f) => f()));
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [text]);

  useEffect(() => ref.current?.focus(), []);

  const submit = async () => {
    const t = text.trim();
    if (!t || running) return;
    setText('');
    const ok = await onSend(t);
    if (!ok) setText(t);
  };

  const showVoice = listening || phase === 'transcribing' || !!partial;

  return (
    <div className="term-input">
      {showVoice && (
        <div className="voice-line">
          <span className="voice-tag">{phase === 'transcribing' ? 'DECODING' : listening ? 'REC' : 'HEARD'}</span>
          <span className="voice-bars" aria-hidden>
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} style={{ height: `${2 + Math.round(level * (4 + ((i * 7) % 11)) * (listening ? 1 : 0))}px` }} />
            ))}
          </span>
          <span className="voice-words">{partial ? `“${partial}”` : phase === 'transcribing' ? 'turning your voice into words…' : 'speak now…'}</span>
        </div>
      )}
      <div className={`prompt-line ${running ? 'busy' : ''}`}>
        <span className="prompt-glyph" aria-hidden>
          {running ? '◌' : '>'}
        </span>
        <textarea
          ref={ref}
          className="prompt-text selectable"
          rows={1}
          value={text}
          spellCheck={false}
          placeholder={running ? 'it is answering… you can type the next thing' : 'transmit to Noli'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="term-btn ghost"
          onClick={() => {
            const prompt = text.trim() ? `${text.trim()} (look at my screen)` : 'Look at my screen and tell me what you see or help me with what I am doing.';
            setText('');
            void onSend(prompt);
          }}
          disabled={running}
          title="Noli inspects your screen"
        >
          👁 SEE SCREEN
        </button>
        {running ? (
          <button className="term-btn danger" onClick={onStop} title="Stop generating">
            ■ STOP
          </button>
        ) : (
          <button className="term-btn" onClick={() => void submit()} disabled={!text.trim()} title="Send (Enter)">
            SEND ↵
          </button>
        )}
      </div>
      <div className="prompt-foot">
        {settings && <MicControl settings={settings} update={update} />}
        <span className="prompt-hint">
          <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
        </span>
      </div>
    </div>
  );
}
