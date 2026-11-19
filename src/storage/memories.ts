import { api } from '../lib/ipc';

/** Long-term memories live in SQLite (Rust). */
export const memories = {
  list: () => api.memories(),
  add: (content: string) => api.memoryAdd(content),
  update: (id: string, content: string) => api.memoryUpdate(id, content),
  remove: (id: string) => api.memoryDelete(id),
  clear: () => api.memoriesClear(),
};

/** Hides memory tags while a reply is streaming. */
export function hideMemoryTags(text: string): string {
  return text.replace(/<remember>[\s\S]*?(<\/remember>|$)/g, '').replace(/<(r(e(m(e(m(b(e(r)?)?)?)?)?)?)?)?$/, '');
}
