import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import { loadAtlas } from '../companion/atlas';
import { buildClips } from '../companion/clips';
import { CompanionMachine, type Mood } from '../companion/machine';
import { reactionFor } from '../companion/reactions';
import { SpriteRenderer } from '../companion/renderer';
import type { ChatEvent } from '../lib/types';
import { settingsStore } from '../lib/useSettings';

/**
 * A small live copy of the creature for the chat window's monitor header.
 * Same atlas, state machine and renderer as the desktop companion, driven by
 * the same chat/voice events, so both react together.
 */
export function MiniPhantom({ onMood }: { onMood?: (m: Mood) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const unsubs: Promise<() => void>[] = [];
    void loadAtlas().then((atlas) => {
      if (!alive || !ref.current) return;
      const m = new CompanionMachine(buildClips(atlas.manifest), { idleVariety: true, sleepAfterMs: 10 * 60_000 }, performance.now());
      const r = new SpriteRenderer(ref.current, atlas);
      setReady(true);
      let mic = 0;
      let speakingUntil = 0;
      let lastText = '';
      let lastMood: Mood | null = null;
      const set = (mood: Mood, d?: number) => m.set(mood, performance.now(), d);
      unsubs.push(
        listen<ChatEvent>('chat://event', ({ payload: e }) => {
          m.touch(performance.now());
          if (e.kind === 'start') {
            lastText = '';
            set('listening');
            setTimeout(() => m.base === 'listening' && set('thinking'), 600);
          } else if (e.kind === 'delta') {
            lastText += e.delta ?? '';
            speakingUntil = performance.now() + 900;
            if (m.base !== 'speaking') set('speaking');
          } else if (e.kind === 'activity' && e.activity?.state === 'running') {
            set('thinking');
          } else if (e.kind === 'done') {
            set('idle');
            const reaction = reactionFor(e.content ?? lastText);
            if (reaction) set(reaction);
          } else if (e.kind === 'error') {
            set('error', 2600);
          } else if (e.kind === 'cancelled') {
            set('idle');
          }
        }),
        listen<{ listening: boolean; phase: string }>('voice://state', ({ payload: s }) => {
          if (s.listening) set('listening');
          else if (s.phase === 'transcribing') set('thinking');
          else if (m.base === 'listening') set('idle');
        }),
        listen<number>('voice://level', ({ payload }) => (mic = payload)),
      );
      const loop = () => {
        if (!alive) return;
        const now = performance.now();
        if (m.base === 'speaking' && now > speakingUntil + 1500) set('idle');
        const fs = m.tick(now);
        if (fs.mood !== lastMood) {
          lastMood = fs.mood;
          onMood?.(fs.mood);
        }
        const mouth = fs.effects.includes('mouth') && now < speakingUntil ? 0.3 + 0.5 * Math.abs(Math.sin(now * 0.017)) : 0.05;
        r.draw({ state: fs, t: now, mouth, mic, flip: false, reducedMotion: !!settingsStore.current?.appearance.reducedMotion });
        timer = setTimeout(loop, document.hidden ? 1000 : m.isAnimatedFast() ? 40 : 90);
      };
      loop();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      unsubs.forEach((u) => void u.then((f) => f()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={ref} className={`mini-phantom pixel ${ready ? 'on' : ''}`} aria-hidden />;
}
