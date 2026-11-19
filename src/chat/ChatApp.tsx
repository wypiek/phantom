import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal } from '../components/ui';
import type { Mood } from '../companion/machine';
import { api, errorText } from '../lib/ipc';
import { prettyShortcut } from '../lib/shortcuts';
import type { PermissionRequest, ProviderId } from '../lib/types';
import { useDocumentAppearance, useSettings } from '../lib/useSettings';
import { PROVIDERS } from '../providers';
import { conversations as convs, relativeTime } from '../storage/conversations';
import { Composer } from './Composer';
import { MessageView } from './MessageView';
import { MiniPhantom } from './MiniPhantom';
import { useChat } from './useChat';

const MOOD_TEXT: Record<Mood, string> = {
  idle: 'lurking',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  happy: 'pleased',
  sad: 'sulking',
  angry: 'agitated',
  confused: 'confused',
  sleeping: 'asleep',
  scared: 'startled',
  glitch: 'glitching',
  error: 'malfunction',
  vanish: 'gone',
};

export function ChatApp() {
  const chat = useChat();
  const { settings, update } = useSettings();
  useDocumentAppearance(settings);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [mood, setMood] = useState<Mood>('idle');

  const provider = settings?.provider.active ?? 'openrouter';
  useEffect(() => {
    if (provider === 'claude-code') api.claudeWorkspace().then((w) => setWorkspace(w.path)).catch(() => setWorkspace(null));
  }, [provider, settings?.provider.claudeCode.workingDirectory]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);
  useEffect(() => {
    stick.current = true;
  }, [chat.activeId]);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2600);
  };

  const conversationMenu = async () => {
    const c = chat.active;
    if (!c) return;
    const items = await Promise.all([
      MenuItem.new({ text: 'Rename', action: () => setRenaming(true) }),
      MenuItem.new({ text: 'Export as Markdown…', action: () => void convs.exportTo(c, 'markdown').then((p) => p && flash(`exported → ${p}`)).catch((e) => chat.setError(errorText(e))) }),
      MenuItem.new({ text: 'Export as JSON…', action: () => void convs.exportTo(c, 'json').then((p) => p && flash(`exported → ${p}`)).catch((e) => chat.setError(errorText(e))) }),
      PredefinedMenuItem.new({ item: 'Separator' }),
      MenuItem.new({ text: 'Clear messages', enabled: !chat.running, action: () => void chat.clear() }),
      MenuItem.new({ text: 'Delete conversation', action: () => void chat.remove(c.id) }),
    ]);
    await (await Menu.new({ items })).popup();
  };

  const lastIndex = chat.messages.length - 1;
  const model = provider === 'openrouter' ? settings?.provider.openrouter.model : settings?.provider.claudeCode.model || 'default model';
  const mic = settings?.voice;

  return (
    <div className={`terminal mood-${mood}`}>
      <div className="scanlines" aria-hidden />

      <aside className="log-rail">
        <div className="rail-top" data-tauri-drag-region>
          <span className="rail-title" data-tauri-drag-region>
            SIGNALS
          </span>
          <button className="term-btn small" onClick={() => void chat.newConversation()} title="New conversation">
            + NEW
          </button>
        </div>
        <label className="rail-search">
          <span aria-hidden>/</span>
          <input placeholder="search the archive" value={chat.query} onChange={(e) => chat.setQuery(e.target.value)} spellCheck={false} />
        </label>
        <nav className="rail-list">
          {chat.list.map((c, i) => (
            <button key={c.id} className={`rail-item ${c.id === chat.activeId ? 'active' : ''}`} onClick={() => void chat.load(c.id)}>
              <span className="rail-idx">{String(chat.list.length - i).padStart(2, '0')}</span>
              <span className="rail-body">
                <span className="rail-name">{c.title}</span>
                <span className="rail-meta">
                  {relativeTime(c.updatedAt)}
                  {c.provider && <> · {c.provider === 'claude-code' ? 'claude code' : 'openrouter'}</>}
                </span>
              </span>
              <span
                className="rail-del"
                role="button"
                tabIndex={-1}
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  void chat.remove(c.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
          {chat.list.length === 0 && <div className="rail-empty">{chat.query ? 'no matching signals' : 'archive empty'}</div>}
        </nav>
        <div className="rail-foot">
          <button onClick={() => void api.openWindow('settings')}>settings</button>
          <button onClick={() => void api.companionToggle()}>summon / hide</button>
        </div>
      </aside>

      <main className="feed">
        <header className="monitor" data-tauri-drag-region>
          <div className="monitor-screen" data-tauri-drag-region>
            <MiniPhantom onMood={setMood} />
          </div>
          <div className="monitor-readout" data-tauri-drag-region>
            <div className="readout-title">
              {renaming && chat.active ? (
                <input
                  className="title-edit"
                  autoFocus
                  defaultValue={chat.active.title}
                  onBlur={(e) => {
                    setRenaming(false);
                    if (e.target.value.trim()) void chat.rename(chat.active!.id, e.target.value.trim());
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(false);
                  }}
                />
              ) : (
                <span onDoubleClick={() => chat.active && setRenaming(true)} title="Double-click to rename">
                  {chat.active?.title ?? 'new transmission'}
                </span>
              )}
              {chat.active && (
                <button className="readout-menu" aria-label="Conversation options" onClick={() => void conversationMenu()}>
                  ⋯
                </button>
              )}
            </div>
            <div className="readout-grid">
              <span className="k">STATE</span>
              <span className={`v state-${mood}`}>{MOOD_TEXT[mood]}</span>
              <span className="k">BRAIN</span>
              <span className="v">
                <select className="readout-select" value={provider} aria-label="AI provider" onChange={(e) => void update((s) => void (s.provider.active = e.target.value as ProviderId))}>
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label.toLowerCase()}
                    </option>
                  ))}
                </select>
                <button className="readout-link" title="Change model" onClick={() => void api.openWindow('settings', 'provider')}>
                  {model}
                </button>
              </span>
              {provider === 'claude-code' && workspace && (
                <>
                  <span className="k">WORKDIR</span>
                  <span className="v path" title={`${workspace} — ${permissionLabel(settings?.provider.claudeCode.permission)}`}>
                    {workspace} <em>· {permissionLabel(settings?.provider.claudeCode.permission)}</em>
                  </span>
                </>
              )}
              <span className="k">VOICE</span>
              <span className="v">
                {!mic?.enabled ? 'mic off' : mic.mode === 'continuous' ? 'continuous listening' : `hold ${prettyShortcut(settings!.general.shortcuts.pushToTalk)} to talk`}
                {settings?.tts.enabled ? ` · speaks as ${settings.tts.preset}` : ' · silent'}
              </span>
            </div>
          </div>
        </header>

        <div
          className="transcript"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {chat.messages.length === 0 ? <NoSignal onPick={(t) => void chat.send(t)} /> : chat.messages.map((m, i) => <MessageView key={m.id} m={m} isLast={i === lastIndex} running={chat.running} onRegenerate={() => void chat.regenerate()} />)}
        </div>

        {chat.error && (
          <div className="term-error">
            <span className="signal-lost-tag">ERR</span>
            <span className="grow selectable">{chat.error}</span>
            <button className="term-btn small" onClick={() => chat.setError(null)}>
              DISMISS
            </button>
          </div>
        )}
        {settings && !settings.privacy.saveHistory && <div className="history-off">history is off — this log is erased when PHANTOM quits</div>}
        <Composer onSend={chat.send} onStop={() => void chat.stop()} running={chat.running} settings={settings} update={update} />
      </main>

      {chat.permissions[0] && <PermissionDialog req={chat.permissions[0]} count={chat.permissions.length} onAnswer={chat.respondPermission} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function permissionLabel(p?: string) {
  return { ask: 'asks before acting', 'accept-edits': 'auto-accepts edits', 'read-only': 'read-only', 'chat-only': 'chat only' }[p ?? 'ask'] ?? '';
}

function NoSignal({ onPick }: { onPick: (t: string) => void }) {
  const ideas = ['what are you, exactly?', 'tell me something unsettling about computers', 'help me name my new project', 'what happens to deleted files?'];
  return (
    <div className="no-signal">
      <div className="static-box" aria-hidden>
        <img src="/sprites/portrait.png" className="pixel" alt="" />
      </div>
      <div className="no-signal-title">NO SIGNAL</div>
      <div className="no-signal-sub">type below, or hold the mic and speak. it is waiting.</div>
      <div className="no-signal-ideas">
        {ideas.map((i) => (
          <button key={i} onClick={() => onPick(i)}>
            <span aria-hidden>&gt;</span> {i}
          </button>
        ))}
      </div>
    </div>
  );
}

function PermissionDialog({ req, count, onAnswer }: { req: PermissionRequest; count: number; onAnswer: (id: string, allow: boolean, remember?: boolean) => void }) {
  const input = JSON.stringify(req.input, null, 2);
  const isBash = req.toolName === 'Bash';
  return (
    <Modal
      title="permission requested"
      onClose={() => onAnswer(req.id, false)}
      actions={
        <>
          <button className="btn danger" onClick={() => onAnswer(req.id, false)}>
            Deny
          </button>
          <div className="grow" />
          <button className="btn" onClick={() => onAnswer(req.id, true, true)} title={isBash ? 'Allow this exact command for the rest of this session' : `Allow ${req.toolName} for the rest of this session`}>
            Always allow {isBash ? 'this command' : req.toolName}
          </button>
          <button className="btn primary" autoFocus onClick={() => onAnswer(req.id, true)}>
            Allow once
          </button>
        </>
      }
    >
      <p>
        The Claude Code agent wants to use <strong className="mono">{req.toolName}</strong>
        {count > 1 && <span className="faint"> ({count - 1} more waiting)</span>}
      </p>
      {req.summary && <div className="perm-summary mono selectable">{req.summary}</div>}
      <div className="perm-ws">
        <span className="label-pill">workspace</span> <span className="mono">{req.workspace || 'unknown'}</span>
      </div>
      <details className="perm-details">
        <summary>Full request</summary>
        <pre className="selectable">{input.length > 4000 ? `${input.slice(0, 4000)}\n…` : input}</pre>
      </details>
    </Modal>
  );
}
