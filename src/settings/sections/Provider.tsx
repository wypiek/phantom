import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useMemo, useState } from 'react';
import { CommitInput, Field, Section, Slider, Status, Toggle, useAsync } from '../../components/ui';
import { api, errorText } from '../../lib/ipc';
import type { ClaudePermission, GroqModelInfo, KeyCheck, ModelInfo, Settings } from '../../lib/types';
import { PROVIDERS } from '../../providers';
import { PERMISSION_MODES } from '../../providers/claude-code';
import { filterModels, formatPrice } from '../../providers/openrouter';

type Props = { s: Settings; update: (m: (d: Settings) => void) => Promise<string[]> };

export function ProviderSection({ s, update }: Props) {
  const active = s.provider.active;
  const health = useAsync(() => Promise.all(PROVIDERS.map((p) => p.health().catch(() => null))), [active]);
  return (
    <>
      <Section title="Choose a brain" description="Switching keeps your conversations; the new provider gets the earlier messages as context.">
        <div className="provider-cards">
          {PROVIDERS.map((p, i) => {
            const h = health.data?.[i];
            return (
              <button key={p.id} className={`choice ${active === p.id ? 'selected' : ''}`} onClick={() => void update((d) => void (d.provider.active = p.id))}>
                <div className="row">
                  <div className="choice-title grow">{p.label}</div>
                  {h ? <Status tone={h.ready ? 'ok' : 'bad'}>{h.ready ? 'ready' : 'set up'}</Status> : <span className="spinner" />}
                </div>
                <div className="choice-desc">{p.tagline}</div>
              </button>
            );
          })}
        </div>
      </Section>
      {active === 'claude-code' && <ClaudeCodeSettings s={s} update={update} />}
      {active === 'openrouter' && <OpenRouterSettings s={s} update={update} />}
      {active === 'groq' && <GroqSettings s={s} update={update} />}
    </>
  );
}

export function ClaudeCodeSettings({ s, update, compact }: Props & { compact?: boolean }) {
  const cc = s.provider.claudeCode;
  const status = useAsync(() => api.claudeStatus(), [cc.binaryPath]);
  const ws = useAsync(() => api.claudeWorkspace(), [cc.workingDirectory]);
  const st = status.data;
  return (
    <Section
      title="Claude Code"
      aside={
        status.loading ? (
          <span className="spinner" />
        ) : st?.loggedIn ? (
          <Status tone="ok">ready</Status>
        ) : (
          <Status tone="bad">{st?.installed ? 'not signed in' : 'not found'}</Status>
        )
      }
    >
      <div className={`notice ${st && !st.error ? 'ok' : st?.error ? 'error' : ''}`}>
        {status.loading && 'Looking for Claude Code…'}
        {st && !st.error && (
          <>
            Found <code>{st.path}</code> {st.version && <>· {st.version}</>} · signed in via {st.authMethod ?? 'Claude account'}
            {st.subscription && <> ({st.subscription})</>}. PHANTOM reuses this login — no extra API key needed.
          </>
        )}
        {st?.error && (
          <>
            {st.error}
            {!st.installed && (
              <div className="install-hint">
                Install: <code>curl -fsSL https://claude.ai/install.sh | bash</code> (macOS/Linux) or <code>npm install -g @anthropic-ai/claude-code</code>, then run <code>claude</code> once to sign in.
              </div>
            )}
          </>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn small" onClick={status.reload}>
            Check again
          </button>
        </div>
      </div>
      <Field label="Working directory" hint="The only folder the agent works in. Pick a project folder, or use PHANTOM's own sandbox folder.">
        <div className="row">
          <div className="input mono ws-display" title={ws.data?.path}>
            {ws.data?.path ?? '…'}
          </div>
          <button
            className="btn small"
            onClick={async () => {
              const dir = await open({ directory: true, multiple: false, title: 'Choose the Claude Code workspace' });
              if (typeof dir === 'string') await update((d) => void (d.provider.claudeCode.workingDirectory = dir));
            }}
          >
            Choose…
          </button>
          {!ws.data?.isDefault && (
            <button className="btn ghost small" onClick={() => void update((d) => void (d.provider.claudeCode.workingDirectory = ''))}>
              Default
            </button>
          )}
        </div>
      </Field>
      <Field label="Permissions" hint="PHANTOM never runs Claude Code with permission checks disabled.">
        <div className="radio-list">
          {PERMISSION_MODES.map((m) => (
            <label key={m.id} className={`radio ${cc.permission === m.id ? 'selected' : ''}`}>
              <input type="radio" name="perm" checked={cc.permission === m.id} onChange={() => void update((d) => void (d.provider.claudeCode.permission = m.id as ClaudePermission))} />
              <div>
                <div>{m.label}</div>
                <div className="faint small-text">{m.description}</div>
              </div>
            </label>
          ))}
        </div>
      </Field>
      {!compact && (
        <>
          <Field label="Model" hint='Optional: an alias like "sonnet" or "opus", or a full model id. Empty uses your Claude Code default.'>
            <CommitInput value={cc.model} placeholder="default" mono onCommit={(v) => void update((d) => void (d.provider.claudeCode.model = v.trim()))} />
          </Field>
          <Field label="Always-allowed tools" hint='One rule per line, e.g. "Bash(git status)" or "WebSearch". Everything else asks.'>
            <textarea
              className="textarea"
              rows={3}
              defaultValue={cc.allowedTools.join('\n')}
              onBlur={(e) => void update((d) => void (d.provider.claudeCode.allowedTools = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)))}
            />
          </Field>
          <Field label="Lightweight mode" hint="Skip your other MCP servers for PHANTOM's sessions. Much smaller context and faster replies." inline>
            <Toggle checked={cc.lightweight} onChange={(v) => void update((d) => void (d.provider.claudeCode.lightweight = v))} />
          </Field>
          <Field label="Executable path" hint="Only if auto-detection fails.">
            <CommitInput value={cc.binaryPath} placeholder={st?.path ?? 'auto-detect'} mono onCommit={(v) => void update((d) => void (d.provider.claudeCode.binaryPath = v.trim()))} />
          </Field>
        </>
      )}
    </Section>
  );
}

export function OpenRouterSettings({ s, update, compact }: Props & { compact?: boolean }) {
  const or = s.provider.openrouter;
  const key = useAsync(() => api.openrouterKeyStatus(), []);
  const [draft, setDraft] = useState('');
  const [check, setCheck] = useState<KeyCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const saveKey = async () => {
    setBusy(true);
    setErr(null);
    setCheck(null);
    try {
      const c = await api.openrouterTest(draft);
      setCheck(c);
      if (c.ok) {
        await api.openrouterSetKey(draft);
        setDraft('');
        key.reload();
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const testStored = async () => {
    setBusy(true);
    setErr(null);
    try {
      setCheck(await api.openrouterTest());
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="OpenRouter" aside={key.data?.configured ? <Status tone="ok">key saved</Status> : <Status tone="bad">no key</Status>}>
      <Field label="API key" hint={<>Stored in your system keychain, never in PHANTOM's files. Get one at openrouter.ai/keys.</>}>
        {key.data?.configured && (
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="mono key-hint">{key.data.hint}</span>
            <button className="btn small" onClick={() => void testStored()} disabled={busy}>
              Test connection
            </button>
            <button
              className="btn danger small"
              onClick={async () => {
                await api.openrouterDeleteKey();
                setCheck(null);
                key.reload();
              }}
            >
              Remove
            </button>
          </div>
        )}
        <div className="row">
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={key.data?.configured ? 'Replace with a new key…' : 'sk-or-v1-…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && draft && void saveKey()}
          />
          <button className="btn primary" disabled={!draft.trim() || busy} onClick={() => void saveKey()}>
            {busy ? <span className="spinner" /> : 'Verify & save'}
          </button>
        </div>
        {check && (
          <div className={`notice ${check.ok ? 'ok' : 'error'}`} style={{ marginTop: 8 }}>
            {check.message}
            {check.ok && check.usage != null && (
              <span className="faint">
                {' '}
                Usage so far ${check.usage.toFixed(2)}
                {check.limit != null ? ` of $${check.limit}` : ''}
                {check.isFreeTier ? ' · free tier' : ''}.
              </span>
            )}
          </div>
        )}
        {err && <div className="notice error" style={{ marginTop: 8 }}>{err}</div>}
      </Field>
      <Field label="Model" hint="Free models from OpenRouter's catalog, or type any model id. Faster models make Noli answer sooner.">
        <ModelPicker value={or.model} needsVision={s.computer.mode !== 'off' && s.computer.sendScreenshots} onChange={(id) => void update((d) => void (d.provider.openrouter.model = id))} />
      </Field>
      {!compact && (
        <>
          <Field label="Temperature" hint="Higher is stranger.">
            <Slider value={or.temperature} min={0} max={2} step={0.05} onChange={(v) => void update((d) => void (d.provider.openrouter.temperature = v))} format={(v) => v.toFixed(2)} label="Temperature" />
          </Field>
          <Field label="Max output tokens">
            <CommitInput value={String(or.maxTokens)} mono onCommit={(v) => void update((d) => void (d.provider.openrouter.maxTokens = Math.max(16, parseInt(v, 10) || 1024)))} />
          </Field>
        </>
      )}
    </Section>
  );
}

function ModelPicker({ value, onChange, needsVision }: { value: string; onChange: (id: string) => void; needsVision?: boolean }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const load = (refresh = false) => {
    setErr(null);
    api.openrouterModels(refresh).then(setModels, (e) => setErr(errorText(e)));
  };
  useEffect(() => load(), []);
  const filtered = useMemo(() => (models ? filterModels(models, q).slice(0, 200) : []), [models, q]);
  const current = models?.find((m) => m.id === value);
  return (
    <div className="model-picker">
      <div className="row">
        <CommitInput value={value} mono placeholder="provider/model-id" onCommit={(v) => v.trim() && onChange(v.trim())} />
        <button className="btn small" onClick={() => setOpen(!open)}>
          {open ? 'Close list' : 'Browse…'}
        </button>
      </div>
      <Recommended models={models} value={value} onChange={onChange} />
      {current && (
        <div className="faint small-text" style={{ marginTop: 6 }}>
          {current.name} · {current.contextLength ? `${Math.round(current.contextLength / 1000)}k context` : ''} {formatPrice(current) && `· ${formatPrice(current)}`}
          {current.vision ? ' · sees screen' : ''}
        </div>
      )}
      {current && !current.vision && needsVision && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          This model can't see images, so Noli can't look at your screen with it. Pick one marked “sees screen” for computer control.
        </div>
      )}
      {models && !current && value && <div className="faint small-text" style={{ marginTop: 4 }}>Custom model id (not in the catalog list).</div>}
      {err && <div className="notice error" style={{ marginTop: 6 }}>Could not load the model list: {err}</div>}
      {open && (
        <div className="model-list">
          <div className="row" style={{ padding: 6 }}>
            <input className="input" autoFocus placeholder="Search models…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn ghost small" onClick={() => load(true)}>
              Refresh
            </button>
          </div>
          {!models && !err && <div className="faint" style={{ padding: 10 }}>Loading…</div>}
          {filtered.map((m) => (
            <button
              key={m.id}
              className={`model-row ${m.id === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="mono">{m.id}</span>
              <span className="faint">
                {m.vision ? 'sees screen · ' : ''}
                {formatPrice(m)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Known-good picks for a desktop companion; only shown if OpenRouter lists them. */
const OPENROUTER_PICKS: { id: string; why: string }[] = [
  { id: 'inclusionai/ling-3.2-flash:free', why: 'fast' },
  { id: 'nvidia/nemotron-3.5-lightning:free', why: 'fastest' },
  { id: 'google/gemma-4-31b-it:free', why: 'clever' },
  { id: 'nvidia/nemotron-3.5-super-vl:free', why: 'good at screens' },
  { id: 'anthropic/claude-haiku-5.5', why: 'fast' },
  { id: 'google/gemini-2.5-flash', why: 'fast · cheap' },
  { id: 'anthropic/claude-sonnet-5.5', why: 'smartest' },
];

function Recommended({ models, value, onChange }: { models: ModelInfo[] | null; value: string; onChange: (id: string) => void }) {
  if (!models) return null;
  const picks = OPENROUTER_PICKS.map((p) => ({ ...p, m: models.find((m) => m.id === p.id) })).filter((p) => p.m);
  if (!picks.length) return null;
  return (
    <div className="chips">
      <span className="faint small-text">Good picks:</span>
      {picks.map((p) => (
        <button key={p.id} className={`chip ${p.id === value ? 'on' : ''}`} onClick={() => onChange(p.id)} title={p.id}>
          {p.m!.name.replace(/\s*\(free\)$/i, '')}{' '}
          <span className="faint">
            {p.why}
            {p.m!.vision ? ' · sees screen' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Groq: one key, very fast inference. Vision-capable models can see the screen. */
export function GroqSettings({ s, update, compact }: Props & { compact?: boolean }) {
  const g = s.provider.groq;
  const key = useAsync(() => api.groqKeyStatus(), []);
  const models = useAsync<GroqModelInfo[]>(() => (key.data?.configured ? api.groqModels() : Promise.resolve([])), [key.data?.configured]);
  const [draft, setDraft] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setCheck({ ok: false, message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const saveKey = () =>
    run(async () => {
      const c = await api.groqTest(draft);
      setCheck(c);
      if (c.ok) {
        await api.groqSetKey(draft);
        setDraft('');
        key.reload();
      }
    });
  const usable = (models.data ?? []).filter((m) => m.active && !/whisper|tts|guard|playai|orpheus/i.test(m.id));
  const vision = (id: string) => /scout|maverick|vision|llama-4/i.test(id);

  return (
    <Section title="Groq" aside={key.data?.configured ? <Status tone="ok">key saved</Status> : <Status tone="bad">no key</Status>}>
      <Field label="API key" hint="Free at console.groq.com/keys. Stored in your system keychain, never in PHANTOM's files.">
        {key.data?.configured && (
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="mono key-hint">{key.data.hint}</span>
            <button className="btn small" disabled={busy} onClick={() => void run(async () => setCheck(await api.groqTest()))}>
              Test connection
            </button>
            <button className="btn danger small" onClick={() => void api.groqDeleteKey().then(() => (setCheck(null), key.reload()))}>
              Remove
            </button>
          </div>
        )}
        <div className="row">
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={key.data?.configured ? 'Replace with a new key…' : 'gsk_…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && draft && void saveKey()}
          />
          <button className="btn primary" disabled={!draft.trim() || busy} onClick={() => void saveKey()}>
            {busy ? <span className="spinner" /> : 'Verify & save'}
          </button>
        </div>
        {check && (
          <div className={`notice ${check.ok ? 'ok' : 'error'}`} style={{ marginTop: 8 }}>
            {check.message}
          </div>
        )}
      </Field>
      <Field label="Model" hint="Models marked “sees screen” can look at screenshots for computer control.">
        {usable.length > 0 ? (
          <select className="select" value={g.model} onChange={(e) => void update((d) => void (d.provider.groq.model = e.target.value))}>
            {!usable.some((m) => m.id === g.model) && <option value={g.model}>{g.model}</option>}
            {usable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {vision(m.id) ? '  · sees screen' : ''}
                {m.contextWindow ? `  · ${Math.round(m.contextWindow / 1000)}k` : ''}
              </option>
            ))}
          </select>
        ) : (
          <CommitInput value={g.model} mono placeholder="llama-3.3-70b-versatile" onCommit={(v) => v.trim() && void update((d) => void (d.provider.groq.model = v.trim()))} />
        )}
        {models.error && <div className="notice error" style={{ marginTop: 6 }}>Could not load models: {models.error}</div>}
      </Field>
      {!compact && (
        <>
          <Field label="Temperature" hint="Higher is stranger.">
            <Slider value={g.temperature} min={0} max={2} step={0.05} onChange={(v) => void update((d) => void (d.provider.groq.temperature = v))} format={(v) => v.toFixed(2)} label="Temperature" />
          </Field>
          <Field label="Max output tokens">
            <CommitInput value={String(g.maxTokens)} mono onCommit={(v) => void update((d) => void (d.provider.groq.maxTokens = Math.max(16, parseInt(v, 10) || 1024)))} />
          </Field>
        </>
      )}
    </Section>
  );
}
