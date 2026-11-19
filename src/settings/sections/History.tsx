import { emitTo, listen } from '@tauri-apps/api/event';
import { useEffect, useMemo, useState } from 'react';
import { useAsync } from '../../components/ui';
import { api, errorText } from '../../lib/ipc';
import { hideMemoryTags } from '../../storage/memories';
import { conversations, relativeTime } from '../../storage/conversations';

/** Browse, continue, export and delete past conversations. */
export function HistorySection() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const list = useAsync(() => conversations.list(query || undefined), [query]);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const un = listen('conversations://changed', () => list.reload());
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!selected && list.data?.length) setSelected(list.data[0].id);
  }, [list.data, selected]);

  return (
    <div className="history">
      <div className="history-list">
        <input className="input" placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="history-items">
          {list.loading && !list.data && <div className="faint pad">Loading…</div>}
          {list.data?.length === 0 && <div className="faint pad">{query ? 'Nothing matches.' : 'No conversations yet. Say hi to Noli.'}</div>}
          {list.data?.map((c) => (
            <button key={c.id} className={`history-item ${c.id === selected ? 'active' : ''}`} onClick={() => setSelected(c.id)}>
              <div className="row">
                <span className="grow ellipsis history-title">{c.title}</span>
                <span className="faint small-text">{relativeTime(c.updatedAt)}</span>
              </div>
              {c.preview && <div className="faint small-text ellipsis">{hideMemoryTags(c.preview)}</div>}
            </button>
          ))}
        </div>
        <button className="btn small" onClick={() => void conversations.create().then((c) => (setSelected(c.id), list.reload()))}>
          + New conversation
        </button>
      </div>
      <div className="history-view">
        {selected ? (
          <Transcript
            id={selected}
            onNote={setNote}
            onDeleted={() => {
              setSelected(null);
              list.reload();
            }}
          />
        ) : (
          <div className="faint pad">Pick a conversation.</div>
        )}
        {note && (
          <div className="notice ok history-note" onClick={() => setNote(null)}>
            {note}
          </div>
        )}
      </div>
    </div>
  );
}

function Transcript({ id, onDeleted, onNote }: { id: string; onDeleted: () => void; onNote: (n: string | null) => void }) {
  const conv = useAsync(() => conversations.get(id), [id]);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [id]);
  useEffect(() => {
    const un = listen<string>('conversations://changed', (e) => e.payload === id && conv.reload());
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const messages = useMemo(() => (conv.data?.messages ?? []).filter((m) => m.content.trim() || m.error), [conv.data]);
  if (conv.error) return <div className="notice error">{conv.error}</div>;
  if (!conv.data) return <div className="faint pad">Loading…</div>;
  const c = conv.data.conversation;

  const continueHere = async () => {
    await api.chatSetActive(c.id);
    await api.companionSetVisible(true);
    await emitTo('companion', 'companion://command', 'chatbox-open');
    onNote('Continuing this conversation in the chatbox next to Noli.');
  };
  const exportIt = async () => {
    try {
      const path = await conversations.exportTo(c, 'markdown');
      if (path) onNote(`Saved to ${path}`);
    } catch (e) {
      onNote(errorText(e));
    }
  };

  return (
    <>
      <div className="transcript-head">
        <div className="grow">
          <div className="transcript-title ellipsis">{c.title}</div>
          <div className="faint small-text">
            {new Date(c.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {c.messageCount} messages{c.provider ? ` · ${c.provider}` : ''}
          </div>
        </div>
        <button className="btn small primary" onClick={() => void continueHere()}>
          Continue
        </button>
        <button className="btn small" onClick={() => void exportIt()}>
          Export
        </button>
        {confirm ? (
          <button className="btn small danger" onClick={() => void conversations.remove(c.id).then(onDeleted)}>
            Really delete
          </button>
        ) : (
          <button className="btn small ghost" onClick={() => setConfirm(true)}>
            Delete
          </button>
        )}
      </div>
      <div className="transcript selectable">
        {messages.length === 0 && <div className="faint pad">Empty.</div>}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            <div className="msg-who">
              {m.role === 'user' ? 'You' : 'Noli'} <span className="faint">{new Date(m.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="msg-text">{hideMemoryTags(m.content).trim() || <span className="faint">({m.status})</span>}</div>
            {m.error && <div className="msg-error">{m.error}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
