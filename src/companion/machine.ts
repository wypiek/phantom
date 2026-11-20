import type { Clip, Effect, Overlay } from './clips';

/** Required behaviour states. */
export type Mood =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'confused'
  | 'sleeping'
  | 'scared'
  | 'glitch'
  | 'error'
  | 'vanish';

export const MOODS: Mood[] = ['idle', 'listening', 'thinking', 'speaking', 'happy', 'sad', 'angry', 'confused', 'sleeping', 'scared', 'glitch', 'error', 'vanish'];

/** Activity states persist; reaction states play for a while then return. */
const BASE: Mood[] = ['idle', 'listening', 'thinking', 'speaking', 'sleeping'];
const DEFAULT_DURATION: Partial<Record<Mood, number>> = {
  happy: 2600,
  sad: 2800,
  angry: 2200,
  confused: 2600,
  scared: 2200,
  glitch: 900,
  error: 2600,
  vanish: 2600,
};

export interface FrameState {
  frame: number;
  clip: string;
  effects: Effect[];
  overlay: Overlay;
  /** 0..1 sprite opacity (vanish) */
  alpha: number;
  /** previous frame for cross-fading, with its remaining alpha */
  prev: { frame: number; alpha: number } | null;
  mood: Mood;
  /** ms since the star-spawn began (only while spawning) */
  spawn?: number;
  /** total length of the current spawn (ms) */
  spawnMs?: number;
}

/** Star-spawn timeline (ms): the star falls, flares, bursts, Noli forms. */
export const SPAWN = { fall: 950, flare: 1350, burst: 1350, reveal: 1300, total: 2700 } as const;
export const SPAWN_SHORT = { fall: 0, flare: 0, burst: 250, reveal: 150, total: 900 } as const;

interface Playing {
  clip: Clip;
  start: number;
  /** clips to play after a non-looping clip ends */
  then: Clip[];
}

export interface MachineOptions {
  idleVariety: boolean;
  sleepAfterMs: number;
  random?: () => number;
}

const CROSSFADE_MS = 160;

/**
 * Time-driven animation state machine. Pure: all timing comes from `now`.
 */
export class CompanionMachine {
  mood: Mood = 'idle';
  base: Mood = 'idle';
  private playing: Playing;
  private transientUntil = 0;
  private lastFrame = -1;
  private fade: { frame: number; at: number } | null = null;
  private nextIdleEvent = 0;
  private lastActivity = 0;
  private alpha = 1;
  private vanishPhase: 'out' | 'hidden' | 'in' | null = null;
  private vanishUntil = 0;
  private spawnAt: number | null = null;
  private spawnTimes: { fall: number; flare: number; burst: number; reveal: number; total: number } = SPAWN;
  private rand: () => number;

  constructor(
    private clips: Record<string, Clip>,
    private opts: MachineOptions,
    now = 0,
  ) {
    this.rand = opts.random ?? Math.random;
    this.playing = { clip: clips.idle, start: now, then: [] };
    this.lastActivity = now;
    this.scheduleIdle(now);
  }

  /** Noli arrives: a star falls and Noli forms out of it. */
  spawn(now: number, short = false) {
    this.spawnAt = now;
    this.spawnTimes = short ? SPAWN_SHORT : SPAWN;
    this.vanishPhase = null;
    this.transientUntil = 0;
    this.fade = null;
    this.lastActivity = now;
    if (this.base === 'sleeping') this.base = 'idle';
    this.mood = this.base;
  }

  get spawning() {
    return this.spawnAt !== null;
  }

  setOptions(o: Partial<MachineOptions>) {
    this.opts = { ...this.opts, ...o };
  }

  /** Mark user interaction (resets the sleep timer, wakes up). */
  touch(now: number) {
    this.lastActivity = now;
    if (this.base === 'sleeping') this.set('idle', now);
  }

  private scheduleIdle(now: number) {
    this.nextIdleEvent = now + 14_000 + this.rand() * 26_000;
  }

  private play(clip: Clip, now: number, then: Clip[] = []) {
    if (this.playing.clip.name === clip.name && clip.loop && then.length === 0) return;
    if (this.lastFrame >= 0) this.fade = { frame: this.lastFrame, at: now };
    this.playing = { clip, start: now, then };
  }

  /** Clip (sequence) for entering a base mood. */
  private enterBase(m: Mood, now: number, from: Mood) {
    const c = this.clips;
    const wake = from === 'sleeping' && m !== 'sleeping' ? [c.stand_up] : [];
    const target: Record<string, Clip> = { idle: c.idle, listening: c.listening, thinking: c.thinking, speaking: c.speaking, sleeping: c.sleeping };
    if (m === 'sleeping') {
      this.play(c.lie_down, now, [c.sleeping]);
    } else if (wake.length) {
      this.play(wake[0], now, [target[m]]);
    } else {
      this.play(target[m], now);
    }
  }

  /**
   * Request a mood. Base moods persist; reaction moods last `durationMs`
   * (or a default) and then return to the current base mood.
   */
  set(m: Mood, now: number, durationMs?: number) {
    if (m !== 'sleeping') this.lastActivity = now;
    if (this.spawnAt !== null) {
      // still arriving: remember activity moods for afterwards, skip reactions
      if (BASE.includes(m) && m !== 'sleeping') this.base = m;
      return;
    }
    const prevMood = this.mood;
    if (BASE.includes(m)) {
      const prevBase = this.base;
      this.base = m;
      // a running reaction keeps playing; base change applies when it ends
      if (this.transientUntil > now && m !== 'listening') return;
      this.transientUntil = 0;
      this.vanishPhase = null;
      this.alpha = 1;
      this.mood = m;
      this.enterBase(m, now, prevMood === 'sleeping' || prevBase === 'sleeping' ? 'sleeping' : prevMood);
      return;
    }
    this.mood = m;
    this.transientUntil = now + (durationMs ?? DEFAULT_DURATION[m] ?? 2500);
    const c = this.clips;
    if (m === 'vanish') {
      this.vanishPhase = 'out';
      this.play(c.vanish_out, now);
      return;
    }
    const map: Partial<Record<Mood, Clip>> = { happy: c.happy, sad: c.sad, angry: c.angry, confused: c.confused, scared: c.scared, glitch: c.glitch, error: c.error };
    const clip = map[m];
    if (clip) {
      // waking up first if needed
      if (this.base === 'sleeping') {
        this.base = 'idle';
        this.play(c.stand_up, now, [clip]);
      } else this.play(clip, now);
    }
  }

  /** Play a one-shot clip (e.g. a poke reaction) then return to base. */
  oneShot(name: string, now: number) {
    const clip = this.clips[name];
    if (!clip) return;
    this.lastActivity = now;
    const back: Record<string, Clip> = { idle: this.clips.idle, listening: this.clips.listening, thinking: this.clips.thinking, speaking: this.clips.speaking, sleeping: this.clips.idle };
    if (this.base === 'sleeping') this.base = 'idle';
    this.mood = this.base;
    this.transientUntil = 0;
    this.play(clip, now, [back[this.base]]);
  }

  /** Forces a looping clip (used while wandering). */
  loopClip(name: string, now: number) {
    const clip = this.clips[name];
    if (clip) this.play(clip, now);
  }

  backToBase(now: number) {
    this.transientUntil = 0;
    this.mood = this.base;
    this.enterBase(this.base, now, 'idle');
  }

  tick(now: number): FrameState {
    if (this.spawnAt !== null) {
      const e = now - this.spawnAt;
      const T = this.spawnTimes;
      if (e < T.total) {
        // Noli materialises out of the star: teleport pixels gathering, fading in
        // only the faint/scattered teleport frames (its solid ones are drawn smaller than Noli),
        // then straight into the full-size idle pose
        const formIn = this.clips.vanish_in.frames.slice(0, 3);
        const r = e - T.reveal;
        const i = r < 0 ? 0 : Math.floor((r / 1000) * this.clips.vanish_in.fps);
        const frame = i < formIn.length ? formIn[i] : this.clips.idle.frames[0];
        const dur = Math.max(1, T.total - T.reveal - 250);
        const alpha = r < 0 ? 0 : Math.min(1, r / dur);
        this.lastFrame = frame;
        return { frame, clip: 'spawn', effects: [], overlay: null, alpha, prev: null, mood: this.mood, spawn: e, spawnMs: T.total };
      }
      this.spawnAt = null;
      this.alpha = 1;
      this.transientUntil = 0;
      this.mood = this.base;
      this.lastFrame = -1;
      this.enterBase(this.base, now, 'idle');
    }
    // reaction finished → return to base
    if (this.transientUntil && now >= this.transientUntil && this.vanishPhase === null) {
      this.transientUntil = 0;
      this.mood = this.base;
      this.enterBase(this.base, now, 'idle');
    }

    // vanish choreography: glitch out → hidden → glitch back in
    if (this.vanishPhase) {
      const p = this.playing;
      const dur = (p.clip.frames.length / p.clip.fps) * 1000;
      const t = Math.min(1, (now - p.start) / dur);
      if (this.vanishPhase === 'out') {
        this.alpha = 1 - t;
        if (t >= 1) {
          this.vanishPhase = 'hidden';
          this.vanishUntil = now + Math.max(400, this.transientUntil - now - dur);
          this.alpha = 0;
        }
      } else if (this.vanishPhase === 'hidden') {
        this.alpha = 0;
        if (now >= this.vanishUntil) {
          this.vanishPhase = 'in';
          this.play(this.clips.vanish_in, now);
        }
      } else if (this.vanishPhase === 'in') {
        this.alpha = t;
        if (t >= 1) {
          this.vanishPhase = null;
          this.alpha = 1;
          this.transientUntil = 0;
          this.mood = this.base;
          this.enterBase(this.base, now, 'idle');
        }
      }
    }

    // idle life: look around / shift weight / doze off
    if (this.mood === 'idle' && this.base === 'idle' && this.playing.clip.loop && this.opts.idleVariety) {
      if (now - this.lastActivity > this.opts.sleepAfterMs) {
        this.set('sleeping', now);
      } else if (now >= this.nextIdleEvent) {
        this.scheduleIdle(now);
        const r = this.rand();
        if (r < 0.5) this.play(this.clips.look_around, now, [this.clips.idle]);
        else if (r < 0.85) this.play(this.clips.idle_alt, now, []);
        else this.play(this.clips.sit, now);
      }
    } else if (this.mood === 'idle' && this.base === 'idle' && (this.playing.clip.name === 'idle_alt' || this.playing.clip.name === 'sit') && now >= this.nextIdleEvent) {
      this.scheduleIdle(now);
      this.play(this.clips.idle, now);
    }

    const { clip, start, then } = this.playing;
    const elapsed = Math.max(0, now - start);
    let i = Math.floor((elapsed / 1000) * clip.fps);
    if (!clip.loop && i >= clip.frames.length) {
      if (then.length) {
        this.play(then[0], now, then.slice(1));
        return this.tick(now);
      }
      i = clip.frames.length - 1;
    }
    // Within a clip, frame changes are hard cuts (pixel-art style); only clip
    // changes cross-fade.
    const frame = clip.frames[i % clip.frames.length];
    this.lastFrame = frame;
    let prev: FrameState['prev'] = null;
    if (this.fade) {
      const k = 1 - (now - this.fade.at) / CROSSFADE_MS;
      if (k <= 0) this.fade = null;
      else prev = { frame: this.fade.frame, alpha: k };
    }
    return { frame, clip: clip.name, effects: clip.effects, overlay: clip.overlay, alpha: this.alpha, prev, mood: this.mood };
  }

  /** True when something is changing every frame (renderer should run fast). */
  isAnimatedFast(): boolean {
    const e = this.playing.clip.effects;
    return this.spawnAt !== null || !!this.fade || this.vanishPhase !== null || e.includes('glitch') || e.includes('mouth') || e.includes('tremble') || e.includes('shake') || e.includes('screen') || e.includes('error') || e.includes('listen');
  }
}
