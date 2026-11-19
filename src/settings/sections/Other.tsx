import { emitTo } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import { Field, Section, Slider, Toggle, useAsync } from '../../components/ui';
import { api, errorText } from '../../lib/ipc';
import type { Settings } from '../../lib/types';
import { MOODS } from '../../companion/machine';
import { memories as mem } from '../../storage/memories';
import { relativeTime } from '../../storage/conversations';

type Props = { s: Settings; update: (m: (d: Settings) => void) => Promise<string[]> };

export function AppearanceSection({ s, update }: Props) {
  const a = s.appearance;
  return (
    <>
      <Section title="Creature">
        <Field label="Idle life" hint="Looks around, shifts its weight, sits, and dozes off when ignored." inline>
          <Toggle checked={a.idleAnimations} onChange={(v) => void update((d) => void (d.appearance.idleAnimations = v))} />
        </Field>
        <Field label="Wander" hint="Occasionally walks a few steps across your screen." inline>
          <Toggle checked={a.wander} onChange={(v) => void update((d) => void (d.appearance.wander = v))} />
        </Field>
        <Field label="Speech bubble" hint="Show what Noli is saying above his head." inline>
          <Toggle checked={a.showSpeechBubble} onChange={(v) => void update((d) => void (d.appearance.showSpeechBubble = v))} />
        </Field>
        <Field label="Reduced motion" hint="No shaking, glitching or wandering." inline>
          <Toggle checked={a.reducedMotion} onChange={(v) => void update((d) => void (d.appearance.reducedMotion = v))} />
        </Field>
        <Field label="Test animations" hint="Make the creature act out each state.">
          <div className="mood-buttons">
            {MOODS.map((m) => (
              <button key={m} className="btn small" onClick={() => void emitTo('companion', 'companion://command', m)}>
                {m}
              </button>
            ))}
            <button className="btn small" onClick={() => void emitTo('companion', 'companion://command', 'idle')}>
              reset
            </button>
          </div>
        </Field>
      </Section>
      <Section title="Interface">
        <Field label="Theme">
          <select className="select" value={a.theme} onChange={(e) => void update((d) => void (d.appearance.theme = e.target.value as 'crypt' | 'void'))}>
            <option value="crypt">Crypt (default)</option>
            <option value="void">Void (darker)</option>
          </select>
        </Field>
        <Field label="Interface scale">
          <Slider value={a.interfaceScale} min={0.85} max={1.4} step={0.05} onChange={(v) => void update((d) => void (d.appearance.interfaceScale = v))} format={(v) => `${Math.round(v * 100)}%`} label="Interface scale" />
        </Field>
        <Field label="UI sounds" hint="Soft blips when messages are sent and received." inline>
          <Toggle checked={a.uiSounds} onChange={(v) => void update((d) => void (d.appearance.uiSounds = v))} />
        </Field>
      </Section>
    </>
  );
}

export function PersonalitySection({ s, update }: Props) {
  const [draft, setDraft] = useState(s.personality.systemPrompt);
  useEffect(() => setDraft(s.personality.systemPrompt), [s.personality.systemPrompt]);
  const dirty = draft !== s.personality.systemPrompt;
  return (
    <Section title="Personality">
      <Field label="System prompt" hint="Who Noli is. Sent with every conversation (Claude Code receives it appended to its own instructions).">
        <textarea className="textarea prompt-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows={16} spellCheck={false} />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={!dirty} onClick={() => void update((d) => void (d.personality.systemPrompt = draft))}>
            Save personality
          </button>
          <button className="btn ghost" disabled={!dirty} onClick={() => setDraft(s.personality.systemPrompt)}>
            Revert
          </button>
          <div className="grow" />
          <button className="btn ghost" onClick={() => void update((d) => void (d.personality.systemPrompt = ''))}>
            Restore default
          </button>
        </div>
      </Field>
      <Field label="Ambient remarks" hint="Very rarely (roughly once an hour at most) Noli mutters something to himself. He never claims to watch what you do without asking." inline>
        <Toggle checked={s.personality.ambientRemarks} onChange={(v) => void update((d) => void (d.personality.ambientRemarks = v))} />
      </Field>
    </Section>
  );
}

const RETENTION: [number, string][] = [
  [0, 'Forever'],
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
  [365, '1 year'],
];

export function PrivacySection({ s, update }: Props) {
  const p = s.privacy;
  const info = useAsync(() => api.appInfo(), []);
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <>
      <Section title="Microphone">
        <Field label="Allow microphone use" hint="When off, PHANTOM never opens the microphone." inline>
          <Toggle checked={s.voice.enabled} onChange={(v) => void update((d) => void (d.voice.enabled = v))} />
        </Field>
        <Field label="Listening mode">
          <div className="dim">
            {s.voice.mode === 'continuous' ? 'Continuous — the mic stays open while PHANTOM runs. Audio is processed locally and discarded after transcription.' : 'Push to talk — the mic is only open while you hold the shortcut or the mic button.'}
          </div>
        </Field>
      </Section>
      <Section title="Conversation history">
        <Field label="Keep history" hint="When off, conversations are deleted when PHANTOM quits." inline>
          <Toggle checked={p.saveHistory} onChange={(v) => void update((d) => void (d.privacy.saveHistory = v))} />
        </Field>
        <Field label="Delete conversations older than">
          <select className="select" value={p.historyRetentionDays} onChange={(e) => void update((d) => void (d.privacy.historyRetentionDays = Number(e.target.value)))}>
            {RETENTION.map(([d, l]) => (
              <option key={d} value={d}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Delete all conversations">
          {confirm === 'convs' ? (
            <div className="row">
              <span className="dim">This cannot be undone.</span>
              <button className="btn danger small" onClick={() => void api.conversationsDeleteAll().then(() => setConfirm(null))}>
                Delete everything
              </button>
              <button className="btn ghost small" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <button className="btn danger small" onClick={() => setConfirm('convs')}>
              Delete all…
            </button>
          )}
        </Field>
      </Section>
      <Section title="Long-term memory">
        <Field label="Remember things about me" hint="PHANTOM may store short facts you share (like your name) and recall them in later conversations." inline>
          <Toggle checked={p.memoryEnabled} onChange={(v) => void update((d) => void (d.privacy.memoryEnabled = v))} />
        </Field>
        <Field label="Forget memories older than">
          <select className="select" value={p.memoryRetentionDays} onChange={(e) => void update((d) => void (d.privacy.memoryRetentionDays = Number(e.target.value)))}>
            {RETENTION.map(([d, l]) => (
              <option key={d} value={d}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <MemoryManager />
      </Section>
      <Section title="Local data">
        <p className="dim section-note">Everything PHANTOM stores (settings, conversations, memories, speech models) stays on this computer. API keys live in the system keychain.</p>
        <div className="row">
          <code className="mono data-path">{info.data?.dataDir}</code>
          <button className="btn small" onClick={() => void api.revealDataDir()}>
            Open folder
          </button>
        </div>
      </Section>
    </>
  );
}

function MemoryManager() {
  const list = useAsync(() => mem.list(), []);
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const un = listen('memories://changed', () => list.reload());
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="memories">
      {list.data?.length === 0 && <div className="faint">No memories yet.</div>}
      {list.data?.map((m) => (
        <div key={m.id} className="memory">
          {editing === m.id ? (
            <input
              className="input"
              autoFocus
              defaultValue={m.content}
              onBlur={(e) => {
                setEditing(null);
                if (e.target.value.trim() && e.target.value !== m.content) void mem.update(m.id, e.target.value).then(list.reload);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <div className="grow selectable" onDoubleClick={() => setEditing(m.id)}>
              {m.content}
              <div className="faint small-text">{relativeTime(m.createdAt)}</div>
            </div>
          )}
          <button className="btn ghost small" onClick={() => setEditing(m.id)}>
            Edit
          </button>
          <button className="btn ghost small" onClick={() => void mem.remove(m.id).then(list.reload)}>
            Forget
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <input className="input" placeholder="Add a memory, e.g. “My name is Sam”" value={adding} onChange={(e) => setAdding(e.target.value)} />
        <button
          className="btn"
          disabled={!adding.trim()}
          onClick={() =>
            void mem
              .add(adding)
              .then(() => (setAdding(''), list.reload()))
              .catch((e) => setErr(errorText(e)))
          }
        >
          Add
        </button>
        {!!list.data?.length && (
          <button className="btn danger" onClick={() => void mem.clear().then(list.reload)}>
            Forget all
          </button>
        )}
      </div>
      {err && <div className="notice error">{err}</div>}
    </div>
  );
}

export function AboutSection({ onRerun }: { onRerun: () => void }) {
  const info = useAsync(() => api.appInfo(), []);
  return (
    <Section title="About">
      <div className="about">
        <img src="/sprites/portrait.png" className="pixel about-portrait" alt="" />
        <div>
          <div className="about-title">Noli</div>
          <div className="dim">A digital creature that escaped into your desktop.</div>
          <div className="faint small-text mono" style={{ marginTop: 8 }}>
            v{info.data?.version} · {info.data?.platform} · approval bridge {info.data?.permissionBridge ? 'online' : 'offline'}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn small" onClick={onRerun}>
              Run setup again
            </button>
            <button className="btn danger small" onClick={() => void api.quit()}>
              Quit Noli
            </button>
          </div>
        </div>
      </div>
    </Section>
  );
}
