import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../lib/ipc';
import type { Activity, ChatEvent, Conversation, Message, PermissionRequest } from '../lib/types';
import { conversations as convs } from '../storage/conversations';
import { blip } from '../lib/sounds';

export interface ChatState {
  list: Conversation[];
  activeId: string | null;
  active: Conversation | null;
  messages: Message[];
  running: boolean;
  error: string | null;
}

export function parseActivities(m: Message): Activity[] {
  if (!m.activity) return [];
  try {
    return JSON.parse(m.activity) as Activity[];
  } catch {
    return [];
  }
}

function mergeActivity(m: Message, a: Activity): Message {
  const list = parseActivities(m);
  const i = list.findIndex((x) => x.id === a.id);
  if (i >= 0) list[i] = a;
  else list.push(a);
  return { ...m, activity: JSON.stringify(list) };
}

/** Pure reducer for streaming events — exported for tests. */
export function applyChatEvent(messages: Message[], e: ChatEvent): Message[] {
  const idx = messages.findIndex((m) => m.id === e.messageId);
  if (idx < 0) return messages;
  const m = messages[idx];
  let next: Message = m;
  switch (e.kind) {
    case 'start':
      next = { ...m, status: 'streaming', provider: e.provider ?? m.provider };
      break;
    case 'delta':
      next = { ...m, content: m.content + (e.delta ?? '') };
      break;
    case 'activity':
      next = e.activity ? mergeActivity(m, e.activity) : m;
      break;
    case 'done':
      next = { ...m, status: 'complete', content: e.content ?? m.content, model: e.model ?? m.model };
      break;
    case 'cancelled':
      next = { ...m, status: 'cancelled', content: e.content ?? m.content };
      break;
    case 'error':
      next = { ...m, status: 'error', error: e.error, content: e.content ?? m.content };
      break;
  }
  const out = messages.slice();
  out[idx] = next;
  return out;
}

export function useChat() {
  const [list, setList] = useState<Conversation[]>([]);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  const streamingRef = useRef(false);
  streamingRef.current = running;

  const refreshList = useCallback(async (q = query) => {
    try {
      setList(await convs.list(q));
    } catch (e) {
      setError(errorText(e));
    }
  }, [query]);

  const load = useCallback(async (id: string | null) => {
    setActiveId(id);
    void api.chatSetActive(id);
    if (!id) {
      setMessages([]);
      setRunning(false);
      return;
    }
    try {
      const d = await convs.get(id);
      if (activeRef.current !== id) return;
      setMessages(d.messages);
      setRunning(d.running);
    } catch (e) {
      setError(errorText(e));
      setActiveId(null);
    }
  }, []);

  // initial load: resume the active conversation (e.g. one started by voice)
  useEffect(() => {
    void (async () => {
      const l = await convs.list();
      setList(l);
      const active = await api.chatGetActive();
      await load(active && l.some((c) => c.id === active) ? active : l[0]?.id ?? null);
      setPermissions(await api.permissionPending());
    })();
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => void refreshList(query), 180);
    return () => clearTimeout(t);
  }, [query, refreshList]);

  useEffect(() => {
    const subs = [
      listen<ChatEvent>('chat://event', ({ payload: e }) => {
        if (e.conversationId !== activeRef.current) {
          // a voice message started elsewhere: follow it
          if (e.kind === 'start' && e.source === 'voice') void load(e.conversationId);
          return;
        }
        if (e.kind === 'start') {
          setRunning(true);
          // the new user + assistant messages are in the DB; reload once
          void convs.get(e.conversationId).then((d) => activeRef.current === e.conversationId && setMessages(d.messages));
          return;
        }
        setMessages((ms) => applyChatEvent(ms, e));
        if (e.kind === 'done') blip('receive');
        if (e.kind === 'error') blip('error');
        if (e.kind === 'done' || e.kind === 'error' || e.kind === 'cancelled') setRunning(false);
      }),
      listen<string | null>('conversations://changed', ({ payload }) => {
        void refreshList();
        if (payload && payload === activeRef.current && !streamingRef.current) {
          void convs.get(payload).then((d) => activeRef.current === payload && (setMessages(d.messages), setRunning(d.running)));
        }
      }),
      listen<PermissionRequest>('permission://request', ({ payload }) => setPermissions((p) => [...p.filter((x) => x.id !== payload.id), payload])),
      listen<string>('permission://resolved', ({ payload }) => setPermissions((p) => p.filter((x) => x.id !== payload))),
    ];
    return () => subs.forEach((s) => void s.then((f) => f()));
  }, [load, refreshList]);

  const send = useCallback(async (text: string) => {
    setError(null);
    try {
      const r = await api.chatSend(text, activeRef.current, 'text');
      blip('send');
      if (r.conversationId !== activeRef.current) {
        setActiveId(r.conversationId);
        activeRef.current = r.conversationId;
      }
      setRunning(true);
      const d = await convs.get(r.conversationId);
      setMessages(d.messages);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }, []);

  const stop = useCallback(async () => {
    if (activeRef.current) await api.chatCancel(activeRef.current);
  }, []);

  const regenerate = useCallback(async () => {
    if (!activeRef.current) return;
    setError(null);
    try {
      await api.chatRegenerate(activeRef.current);
      setRunning(true);
      const d = await convs.get(activeRef.current);
      setMessages(d.messages);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const newConversation = useCallback(async () => {
    const c = await convs.create();
    await refreshList();
    await load(c.id);
  }, [load, refreshList]);

  const remove = useCallback(async (id: string) => {
    await convs.remove(id);
    const l = await convs.list(query);
    setList(l);
    if (activeRef.current === id) await load(l[0]?.id ?? null);
  }, [load, query]);

  const clear = useCallback(async () => {
    if (!activeRef.current) return;
    try {
      await convs.clear(activeRef.current);
      setMessages([]);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    await convs.rename(id, title);
    await refreshList();
  }, [refreshList]);

  const respondPermission = useCallback(async (id: string, allow: boolean, remember = false) => {
    await api.permissionRespond(id, allow, remember);
    setPermissions((p) => p.filter((x) => x.id !== id));
  }, []);

  const active = list.find((c) => c.id === activeId) ?? null;
  return { list, query, setQuery, activeId, active, messages, running, error, setError, permissions, load, send, stop, regenerate, newConversation, remove, clear, rename, respondPermission };
}
