import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './ipc';
import type { Settings } from './types';

type Listener = (s: Settings) => void;

/** Process-wide settings cache shared by hooks and non-React modules. */
class SettingsStore {
  current: Settings | null = null;
  private listeners = new Set<Listener>();
  private loading: Promise<Settings> | null = null;

  load(): Promise<Settings> {
    if (this.current) return Promise.resolve(this.current);
    if (!this.loading) {
      this.loading = api.settingsGet().then((s) => {
        this.set(s);
        return s;
      });
      void listen<Settings>('settings://changed', (e) => this.set(e.payload));
    }
    return this.loading;
  }

  set(s: Settings) {
    this.current = s;
    this.listeners.forEach((l) => l(s));
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async update(mutate: (draft: Settings) => void): Promise<string[]> {
    const base = this.current ?? (await this.load());
    const draft: Settings = structuredClone(base);
    mutate(draft);
    this.set(draft); // optimistic
    const res = await api.settingsUpdate(draft);
    this.set(res.settings);
    return res.warnings;
  }
}

export const settingsStore = new SettingsStore();

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(settingsStore.current);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const unsub = settingsStore.subscribe((s) => mounted.current && setSettings(s));
    void settingsStore.load().then((s) => mounted.current && setSettings(s));
    return () => {
      mounted.current = false;
      unsub();
    };
  }, []);
  const update = useCallback((mutate: (draft: Settings) => void) => settingsStore.update(mutate), []);
  return { settings, update };
}

/** Applies theme + interface scale + reduced motion to the document. */
export function useDocumentAppearance(settings: Settings | null) {
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    root.dataset.theme = settings.appearance.theme;
    root.style.setProperty('--ui-scale', String(settings.appearance.interfaceScale));
    root.classList.toggle('reduced-motion', settings.appearance.reducedMotion);
  }, [settings]);
}
