import { useState } from 'react';
import type { Activity, Message } from '../lib/types';
import { hideMemoryTags } from '../storage/memories';
import { Markdown } from './Markdown';
import { parseActivities } from './useChat';

const STATE_GLYPH: Record<Activity['state'], string> = { running: '', done: 'OK', error: 'ERR', denied: 'DENIED', info: '··' };

function ActivityRow({ a }: { a: Activity }) {
  return (
    <div className={`op op-${a.state}`}>
      <span className="op-state">{a.state === 'running' ? <span className="spinner" /> : STATE_GLYPH[a.state]}</span>
      <span className="op-label">{a.label}</span>
      {a.detail && <span className="op-detail">{a.detail}</span>}
    </div>
  );
}

export function ActivityList({ items, live }: { items: Activity[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = items.filter((a) => a.kind === 'tool');
  const status = items.filter((a) => a.kind === 'status');
  if (!items.length) return null;
  const visible = open || live ? items : status;
  return (
    <div className="ops">
      {visible.map((a) => (
        <ActivityRow key={a.id} a={a} />
      ))}
      {!live && tools.length > 0 && (
        <button className="op-toggle" onClick={() => setOpen(!open)}>
          {open ? '[ hide agent log ]' : `[ ${tools.length} agent step${tools.length === 1 ? '' : 's'} ]`}
        </button>
      )}
    </div>
  );
}

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function MessageView({ m, isLast, onRegenerate, running }: { m: Message; isLast: boolean; onRegenerate: () => void; running: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = m.role === 'assistant' ? hideMemoryTags(m.content) : m.content;
  const streaming = m.status === 'streaming';
  const activities = parseActivities(m);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const Actions = ({ regen }: { regen?: boolean }) => (
    <span className="entry-actions">
      {text && <button onClick={copy}>{copied ? 'copied' : 'copy'}</button>}
      {regen && (
        <button onClick={onRegenerate} disabled={running}>
          regenerate
        </button>
      )}
    </span>
  );

  if (m.role === 'user') {
    return (
      <div className="entry entry-user">
        <div className="entry-head">
          <span className="who">YOU</span>
          <span className="ts">{clock(m.createdAt)}</span>
          <Actions />
        </div>
        <div className="entry-body user-text selectable">{text}</div>
      </div>
    );
  }

  return (
    <div className={`entry entry-phantom ${streaming ? 'streaming' : ''} ${m.status === 'error' ? 'has-error' : ''}`}>
      <div className="entry-head">
        <span className="who">Noli</span>
        <span className="ts">{clock(m.createdAt)}</span>
        {m.model && <span className="model">{m.model}</span>}
        {!streaming && <Actions regen={isLast && m.status !== 'error'} />}
      </div>
      <ActivityList items={activities} live={streaming} />
      <div className="entry-body">
        {text ? <Markdown text={text} /> : streaming ? <Thinking /> : null}
        {streaming && text && <span className="cursor" aria-hidden />}
      </div>
      {m.status === 'error' && (
        <div className="signal-lost">
          <span className="signal-lost-tag">SIGNAL LOST</span>
          <span className="signal-lost-msg selectable">{m.error ?? 'Something went wrong.'}</span>
          {isLast && (
            <button className="term-btn small" onClick={onRegenerate} disabled={running}>
              RETRY
            </button>
          )}
        </div>
      )}
      {m.status === 'cancelled' && <div className="entry-note">— transmission cut —</div>}
    </div>
  );
}

function Thinking() {
  return (
    <div className="thinking" aria-label="Noli is thinking">
      <span />
      <span />
      <span />
      <em>it is thinking</em>
    </div>
  );
}
