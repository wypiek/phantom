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

/** A soft falling-star twinkle for when Noli arrives. */
export function starChime() {
  if (!settingsStore.current?.appearance.uiSounds) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.05;
    // a descending glissando while the star falls, then a sparkle when it lands
    const fall = ctx.createOscillator();
    const fg = ctx.createGain();
    fall.type = 'sine';
    fall.frequency.setValueAtTime(2400, t0);
    fall.frequency.exponentialRampToValueAtTime(700, t0 + 0.9);
    fg.gain.setValueAtTime(0.0001, t0);
    fg.gain.exponentialRampToValueAtTime(0.018, t0 + 0.1);
    fg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.95);
    fall.connect(fg).connect(ctx.destination);
    fall.start(t0);
    fall.stop(t0 + 1);
    [1568, 2093, 2637, 3136].forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      const t = t0 + 1.32 + i * 0.07;
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.03, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.connect(g).connect(ctx!.destination);
      o.start(t);
      o.stop(t + 0.5);
    });
  } catch {
    /* audio unavailable */
  }
}
