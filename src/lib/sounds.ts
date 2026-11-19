import { settingsStore } from './useSettings';

let ctx: AudioContext | null = null;

/** Tiny square-wave blips for UI feedback (respects Settings → Appearance → UI sounds). */
export function blip(kind: 'send' | 'receive' | 'error') {
  if (!settingsStore.current?.appearance.uiSounds) return;
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime;
    const notes = { send: [660, 880], receive: [440, 330], error: [180, 140] }[kind];
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.035, t + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + 0.06);
      o.connect(g).connect(ctx!.destination);
      o.start(t + i * 0.07);
      o.stop(t + i * 0.07 + 0.07);
    });
  } catch {
    /* audio unavailable */
  }
}
