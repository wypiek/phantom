import { save } from '@tauri-apps/plugin-dialog';
import { api } from '../lib/ipc';
import type { Conversation } from '../lib/types';

/** Conversation persistence lives in SQLite (Rust); these are UI helpers. */
export const conversations = {
  list: (query?: string) => api.conversations(query),
  get: (id: string) => api.conversation(id),
  create: () => api.conversationCreate(),
  rename: (id: string, title: string) => api.conversationRename(id, title),
  remove: (id: string) => api.conversationDelete(id),
  clear: (id: string) => api.conversationClear(id),
  removeAll: () => api.conversationsDeleteAll(),

  /** Asks where to save, then exports. Returns the path or null if cancelled. */
  async exportTo(c: Conversation, format: 'markdown' | 'json'): Promise<string | null> {
    const ext = format === 'json' ? 'json' : 'md';
    const safe = c.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'conversation';
    const path = await save({ defaultPath: `${safe}.${ext}`, filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [ext] }] });
    if (!path) return null;
    await api.conversationExport(c.id, format, path);
    return path;
  },
};

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
