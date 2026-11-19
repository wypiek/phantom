import { describe, expect, it } from 'vitest';
import { applyChatEvent, parseActivities } from './useChat';
import type { ChatEvent, Message } from '../lib/types';

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'a1',
  conversationId: 'c',
  role: 'assistant',
  content: '',
  createdAt: 0,
  provider: null,
  model: null,
  status: 'streaming',
  error: null,
  activity: null,
  ...over,
});
const ev = (over: Partial<ChatEvent>): ChatEvent => ({ conversationId: 'c', messageId: 'a1', kind: 'delta', delta: null, content: null, activity: null, error: null, source: null, provider: null, model: null, ...over });

describe('applyChatEvent', () => {
  it('appends deltas and finalizes', () => {
    let ms = [msg()];
    ms = applyChatEvent(ms, ev({ delta: 'Hel' }));
    ms = applyChatEvent(ms, ev({ delta: 'lo' }));
    expect(ms[0].content).toBe('Hello');
    ms = applyChatEvent(ms, ev({ kind: 'done', content: 'Hello.', model: 'm' }));
    expect(ms[0]).toMatchObject({ content: 'Hello.', status: 'complete', model: 'm' });
  });

  it('merges activity updates by id', () => {
    let ms = [msg()];
    ms = applyChatEvent(ms, ev({ kind: 'activity', activity: { id: 't', kind: 'tool', label: 'Bash', detail: null, state: 'running' } }));
    ms = applyChatEvent(ms, ev({ kind: 'activity', activity: { id: 't', kind: 'tool', label: 'Bash', detail: 'ls', state: 'done' } }));
    const acts = parseActivities(ms[0]);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ state: 'done', detail: 'ls' });
  });

  it('records errors and ignores unknown messages', () => {
    const ms = [msg()];
    expect(applyChatEvent(ms, ev({ messageId: 'other', delta: 'x' }))).toBe(ms);
    const out = applyChatEvent(ms, ev({ kind: 'error', error: 'boom' }));
    expect(out[0]).toMatchObject({ status: 'error', error: 'boom' });
  });
});
