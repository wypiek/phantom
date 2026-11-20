import type { Atlas, Rect } from './atlas';
import { SPAWN, SPAWN_SHORT, type FrameState } from './machine';

const SCREEN = '#140d1e';
const GLOW = '#E9D8FF';
const LAVENDER = '#D4B5FF';
const PURPLE = '#A879FF';
const RED = '#E84B65';
const WHITE = '#FFFFFF';
const DEEP = '#6B3FD1';
/** Where the star lands: the little star on Noli's chest. */
const STAR_HOME = { x: 64, y: 68 };
const STAR_START = { x: 116, y: -4 };

export interface DrawInput {
  state: FrameState;
  /** ms timestamp */
  t: number;
  /** 0..1 speech loudness (mouth) */
  mouth: number;
  /** 0..1 microphone level */
  mic: number;
  flip: boolean;
  reducedMotion: boolean;
}

/**
 * Draws atlas frames into a canvas at native pixel resolution; CSS scales the
 * canvas up with `image-rendering: pixelated` so pixels stay crisp at any size.
 */
export class SpriteRenderer {
  readonly w: number;
  readonly h: number;
  private ctx: CanvasRenderingContext2D;
  private scratch: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;

  constructor(
    canvas: HTMLCanvasElement,
    private atlas: Atlas,
  ) {
    this.w = atlas.manifest.cell.w;
    this.h = atlas.manifest.cell.h;
    canvas.width = this.w;
    canvas.height = this.h;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
    this.scratch = document.createElement('canvas');
    this.scratch.width = this.w;
    this.scratch.height = this.h;
    this.sctx = this.scratch.getContext('2d')!;
    this.sctx.imageSmoothingEnabled = false;
  }

  face(frame: number): Rect | null {
    return this.atlas.manifest.faces[frame] ?? null;
  }

  /** Bounding box of the head in cell coordinates (used to place DOM overlays). */
  headAnchor(frame: number): { x: number; y: number } {
    const f = this.face(frame);
    return f ? { x: f.x + f.w / 2, y: f.y } : { x: this.w / 2, y: 24 };
  }

  private blit(ctx: CanvasRenderingContext2D, frame: number) {
    const r = this.atlas.manifest.frames[frame];
    ctx.drawImage(this.atlas.image, r.x, r.y, r.w, r.h, 0, 0, this.w, this.h);
  }

  draw(d: DrawInput) {
    const { state: s, t } = d;
    const ctx = this.ctx;
    const motion = !d.reducedMotion;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (s.alpha <= 0.001) {
      if (s.spawn !== undefined) this.drawSpawn(ctx, s.spawn, s.spawnMs ?? SPAWN.total, motion, t);
      return;
    }

    // ---- body transform -----------------------------------------------------
    let dx = 0;
    let dy = 0;
    let sy = 1;
    let rot = 0;
    const e = s.effects;
    if (motion) {
      if (e.includes('breath')) sy = 1 + 0.012 * Math.sin(t * 0.0018);
      if (e.includes('listen')) sy += d.mic * 0.025;
      if (e.includes('bob')) dy -= Math.round(Math.abs(Math.sin(t * 0.006)) * 3);
      if (e.includes('tremble')) {
        dx += Math.round((Math.random() - 0.5) * 2.4);
        dy += Math.round((Math.random() - 0.5) * 1.6);
      }
      if (e.includes('shake')) dx += Math.round(Math.sin(t * 0.07) * 2);
      if (e.includes('tilt')) rot = Math.sin(t * 0.0016) * 0.035;
    }
    if (e.includes('droop')) dy += 2;
    const ax = this.w / 2;
    const ay = this.h - 2;

    const body = this.sctx;
    body.setTransform(1, 0, 0, 1, 0, 0);
    body.clearRect(0, 0, this.w, this.h);
    if (d.flip) {
      body.translate(this.w, 0);
      body.scale(-1, 1);
    }
    if (s.prev) {
      body.globalAlpha = s.prev.alpha;
      this.blit(body, s.prev.frame);
      body.globalAlpha = 1 - s.prev.alpha * 0.85;
    }
    this.blit(body, s.frame);
    body.globalAlpha = 1;
    body.setTransform(1, 0, 0, 1, 0, 0);

    // Face effects drawn into the body layer (so they flip/transform with it).
    // "eyes" characters (Noli) glow and blink; "screen" characters get a CRT mouth.
    const face = this.face(s.frame);
    const eyesStyle = this.atlas.manifest.faceStyle === 'eyes';
    if (face) {
      const f = d.flip ? { ...face, x: this.w - face.x - face.w } : face;
      if (eyesStyle) {
        if (e.includes('error')) this.tintFace(body, f, RED, t);
        else {
          const blinking = motion && s.clip !== 'sleeping' && !e.includes('glitch') && t % 4700 < 130;
          if (blinking) this.blink(body, f);
          else if (e.includes('mouth')) this.eyeGlow(body, f, 0.2 + Math.min(1, d.mouth * 1.3) * 0.8);
          else if (e.includes('screen')) this.eyeGlow(body, f, 0.3 + 0.3 * Math.sin(t * 0.006));
        }
      } else {
        if (e.includes('mouth')) this.drawMouth(body, f, d.mouth, t);
        if (e.includes('screen')) this.drawScreenPattern(body, f, t);
        if (e.includes('error')) this.tintFace(body, f, RED, t);
      }
    }
    if (e.includes('error')) {
      body.globalCompositeOperation = 'source-atop';
      body.fillStyle = `rgba(232,75,101,${0.16 + (motion ? Math.random() * 0.12 : 0)})`;
      body.fillRect(0, 0, this.w, this.h);
      if (motion) this.sprinkle(body, RED, 26);
      body.globalCompositeOperation = 'source-over';
    }

    ctx.globalAlpha = s.alpha;
    ctx.translate(ax + dx, ay + dy);
    ctx.rotate(rot);
    ctx.scale(1, sy);
    ctx.translate(-ax, -ay);
    if (e.includes('glitch') && motion) this.drawGlitched(ctx, t);
    else ctx.drawImage(this.scratch, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;

    // ---- overlays ----------------------------------------------------------
    const head = this.headAnchor(s.frame);
    const hx0 = d.flip ? this.w - head.x : head.x;
    // Noli's floating sparkle sits right of the head, so its marks go on the left.
    const hx = eyesStyle ? hx0 - 32 : hx0;
    if (s.overlay === 'zzz') this.drawZzz(ctx, hx + 10, head.y - 2, t, motion);
    if (s.overlay === 'exclaim') this.drawIcon(ctx, 'exclaim', hx + 16, head.y - 26 + (motion ? Math.round(Math.sin(t * 0.01)) : 0), 0.55);
    if (s.overlay === 'question') this.drawIcon(ctx, 'question', hx + 14, head.y - 26 + (motion ? Math.round(Math.sin(t * 0.004) * 2) : 0), 0.55);
    if (s.overlay === 'heart') this.drawIcon(ctx, 'heart', hx + 12, head.y - 24 - (motion ? Math.round((t / 60) % 8) : 0), 0.4);
    if (e.includes('listen')) this.drawMicBars(ctx, hx - 22, head.y + 8, d.mic);
    if (eyesStyle && e.includes('mouth') && d.mouth > 0.12) this.drawSoundMarks(ctx, hx0 - 14, head.y + 4, d.mouth, t);
    if (s.spawn !== undefined) this.drawSpawn(ctx, s.spawn, s.spawnMs ?? SPAWN.total, motion, t);
  }

  // ---- arrival: a star falls, flares, bursts, and Noli forms out of it ----------

  private starPos(e: number, fall: number): { x: number; y: number } {
    if (fall <= 0 || e >= fall) return STAR_HOME;
    const p = Math.max(0, e / fall);
    // accelerate like something falling, curve slightly on the way down
    const k = p * p * (3 - 2 * p) * 0.35 + p * p * 0.65;
    return {
      x: STAR_START.x + (STAR_HOME.x - STAR_START.x) * k + Math.sin(p * Math.PI) * 9,
      y: STAR_START.y + (STAR_HOME.y - STAR_START.y) * k,
    };
  }

  private drawSpawn(c: CanvasRenderingContext2D, e: number, total: number, motion: boolean, t: number) {
    const T = total === SPAWN_SHORT.total ? SPAWN_SHORT : SPAWN;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    if (!motion) {
      // reduced motion: a still star that glows and fades while Noli appears
      const k = 1 - e / T.total;
      this.glow(c, STAR_HOME.x, STAR_HOME.y, 26, 0.5 * k);
      this.drawStar(c, STAR_HOME.x, STAR_HOME.y, 4, 2, k);
      c.restore();
      return;
    }
    // trail behind the falling star
    if (e < T.fall + 160) {
      for (let i = 14; i >= 1; i--) {
        const te = e - i * 24;
        if (te < 0 || te > T.fall) continue;
        const p = this.starPos(te, T.fall);
        const fade = (1 - i / 15) * (e > T.fall ? 1 - (e - T.fall) / 160 : 1);
        const jitter = hash(i * 13 + Math.floor(t / 70)) > 0.6 ? 1 : 0;
        c.globalAlpha = Math.max(0, fade) * 0.9;
        c.fillStyle = i < 4 ? GLOW : i < 9 ? LAVENDER : PURPLE;
        const size = i < 5 ? 2 : 1;
        c.fillRect(Math.round(p.x) + jitter, Math.round(p.y), size, size);
        // loose glitter
        if (hash(i * 31 + Math.floor(te / 40)) > 0.72) {
          c.globalAlpha = fade * 0.7;
          c.fillStyle = WHITE;
          c.fillRect(Math.round(p.x + (hash(i * 7) - 0.5) * 8), Math.round(p.y + (hash(i * 11) - 0.5) * 6), 1, 1);
        }
      }
    }
    const pos = this.starPos(e, T.fall);
    const twinkle = 0.75 + 0.25 * Math.sin(t * 0.04);
    if (e < T.fall) {
      // falling: small and bright
      this.glow(c, pos.x, pos.y, 10, 0.45);
      this.drawStar(c, pos.x, pos.y, 3 + (Math.floor(t / 90) % 2), 1, 1);
    } else if (e < T.burst) {
      // landed: hovers and flares up, rays growing
      const p = (e - T.fall) / Math.max(1, T.burst - T.fall);
      const bob = Math.round(Math.sin(p * Math.PI * 3) * 1.5);
      this.glow(c, pos.x, pos.y + bob, 12 + p * 22, 0.35 + p * 0.45);
      this.drawStar(c, pos.x, pos.y + bob, Math.round(4 + p * 8 * twinkle), Math.round(1 + p * 4), 1);
    } else {
      const b = e - T.burst;
      // flash
      const flash = Math.max(0, 1 - b / 380);
      if (flash > 0) this.glow(c, STAR_HOME.x, STAR_HOME.y, 30 + b * 0.12, 0.85 * flash);
      // expanding ring of pixels
      if (b < 520) {
        const r = 4 + (b / 520) * 50;
        c.globalAlpha = (1 - b / 520) * 0.85;
        c.fillStyle = LAVENDER;
        const n = Math.round(r * 2.4);
        for (let i = 0; i < n; i++) {
          if (hash(i * 3 + 1) < 0.25) continue; // broken, glitchy ring
          const a = (i / n) * Math.PI * 2;
          c.fillRect(Math.round(STAR_HOME.x + Math.cos(a) * r), Math.round(STAR_HOME.y + Math.sin(a) * r * 0.9), 1, 1);
        }
      }
      // sparks flying out, slowing down and drifting upward
      const life = 1150;
      if (b < life) {
        for (let i = 0; i < 26; i++) {
          const ang = hash(i * 17 + 3) * Math.PI * 2;
          const speed = 26 + hash(i * 29 + 5) * 44; // px/s
          const tt = b / 1000;
          const dist = speed * (1 - Math.exp(-tt * 3)) / 3 * 3.2;
          const x = STAR_HOME.x + Math.cos(ang) * dist;
          const y = STAR_HOME.y + Math.sin(ang) * dist * 0.9 - tt * tt * 10;
          const fade = 1 - b / life;
          const blink = hash(i * 5 + Math.floor(t / 80)) > 0.25 ? 1 : 0.35;
          c.globalAlpha = fade * blink;
          c.fillStyle = [WHITE, GLOW, LAVENDER, PURPLE, DEEP][i % 5];
          const sz = i % 4 === 0 && fade > 0.5 ? 2 : 1;
          c.fillRect(Math.round(x), Math.round(y), sz, sz);
        }
      }
      // the star shrinks into Noli's chest
      const shrink = Math.max(0, 1 - b / 650);
      if (shrink > 0) this.drawStar(c, STAR_HOME.x, STAR_HOME.y, Math.max(1, Math.round(12 * shrink)), Math.round(5 * shrink), Math.min(1, shrink * 1.6));
      // glitter settling over the forming body
      if (e > T.reveal) {
        const r = (e - T.reveal) / Math.max(1, T.total - T.reveal);
        for (let i = 0; i < 9; i++) {
          if (hash(i * 41 + Math.floor(t / 110)) < 0.45) continue;
          const x = 34 + hash(i * 19 + 7) * 62;
          const y = 26 + hash(i * 23 + 2) * 96;
          c.globalAlpha = (1 - r) * 0.9;
          this.drawStar(c, x, y, 1 + (i % 2), 0, (1 - r) * 0.9);
        }
      }
    }
    c.restore();
    c.globalAlpha = 1;
  }

  /** A 4-point pixel star: bright core, rays fading to lavender, optional diagonals. */
  private drawStar(c: CanvasRenderingContext2D, fx: number, fy: number, arm: number, diag: number, alpha: number) {
    const x = Math.round(fx);
    const y = Math.round(fy);
    c.globalAlpha = alpha;
    c.fillStyle = GLOW;
    c.fillRect(x - 1, y - 1, 3, 3);
    c.fillStyle = WHITE;
    c.fillRect(x, y, 1, 1);
    for (let i = 2; i <= arm; i++) {
      const k = i / (arm + 1);
      c.globalAlpha = alpha * (1 - k * 0.7);
      c.fillStyle = k < 0.35 ? WHITE : k < 0.7 ? GLOW : LAVENDER;
      c.fillRect(x + i, y, 1, 1);
      c.fillRect(x - i, y, 1, 1);
      c.fillRect(x, y + i, 1, 1);
      c.fillRect(x, y - i, 1, 1);
    }
    for (let i = 2; i <= diag; i++) {
      c.globalAlpha = alpha * (1 - i / (diag + 1)) * 0.8;
      c.fillStyle = LAVENDER;
      c.fillRect(x + i, y + i, 1, 1);
      c.fillRect(x - i, y + i, 1, 1);
      c.fillRect(x + i, y - i, 1, 1);
      c.fillRect(x - i, y - i, 1, 1);
    }
    c.globalAlpha = 1;
  }

  private glow(c: CanvasRenderingContext2D, x: number, y: number, r: number, strength: number) {
    if (strength <= 0.01) return;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(233,216,255,${0.7 * strength})`);
    g.addColorStop(0.35, `rgba(168,121,255,${0.35 * strength})`);
    g.addColorStop(1, 'rgba(107,63,209,0)');
    const op = c.globalCompositeOperation;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 1;
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
    c.globalCompositeOperation = op;
  }

  /** Little pixel arcs beside the head, louder speech = more arcs. */
  private drawSoundMarks(c: CanvasRenderingContext2D, x: number, y: number, level: number, t: number) {
    const n = level > 0.6 ? 3 : level > 0.3 ? 2 : 1;
    c.fillStyle = LAVENDER;
    for (let i = 0; i < n; i++) {
      const r = 3 + i * 3;
      const flicker = Math.floor(t / 90 + i) % 4 === 0 ? 0.4 : 0.9;
      c.globalAlpha = flicker * (1 - i * 0.2);
      for (let k = -r; k <= r; k++) {
        const dx = Math.round(Math.sqrt(Math.max(0, r * r - k * k)) * 0.6);
        c.fillRect(x - dx - i, y + k, 1, 1);
      }
    }
    c.globalAlpha = 1;
  }

  /** Soft glow around the eyes (speaking / thinking). */
  private eyeGlow(c: CanvasRenderingContext2D, f: Rect, strength: number) {
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    const r = Math.max(f.w, 8) * 0.9;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(233,216,255,${0.55 * strength})`);
    g.addColorStop(1, 'rgba(168,121,255,0)');
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = g;
    c.fillRect(cx - r, cy - r, r * 2, r * 2);
    c.globalCompositeOperation = 'source-over';
  }

  /** Closes the eyes for a moment: cover them with head colour, leave a thin lid line. */
  private blink(c: CanvasRenderingContext2D, f: Rect) {
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = '#0e0a15';
    c.fillRect(f.x - 1, f.y - 1, f.w + 2, f.h + 2);
    c.fillStyle = 'rgba(212,181,255,0.55)';
    c.fillRect(f.x, f.y + Math.floor(f.h / 2), f.w, 1);
    c.globalCompositeOperation = 'source-over';
  }

  private drawMouth(c: CanvasRenderingContext2D, f: Rect, level: number, t: number) {
    const top = f.y + Math.floor(f.h * 0.52);
    const h = f.y + f.h - top + 1;
    const mid = top + Math.floor(h / 2);
    c.fillStyle = SCREEN;
    c.fillRect(f.x - 1, top, f.w + 2, h + 1);
    c.fillStyle = GLOW;
    const amp = Math.min(1, level * 1.4);
    for (let x = 0; x < f.w; x++) {
      const wave = Math.sin(x * 0.95 + t * 0.03) * 0.7 + Math.sin(x * 0.37 - t * 0.021) * 0.3;
      const y = mid + Math.round(wave * amp * (h / 2));
      c.fillRect(f.x + x, y, 1, 1);
      if (amp > 0.35) c.fillRect(f.x + x, mid, 1, 1);
    }
  }

  private drawScreenPattern(c: CanvasRenderingContext2D, f: Rect, t: number) {
    const pad = 1;
    c.fillStyle = SCREEN;
    c.fillRect(f.x - pad, f.y - pad, f.w + pad * 2, f.h + pad * 2);
    const phase = Math.floor(t / 2600) % 4;
    c.fillStyle = LAVENDER;
    if (phase === 0) {
      // loading dots
      const n = Math.floor(t / 300) % 4;
      for (let i = 0; i < 3; i++) {
        c.globalAlpha = i < n ? 1 : 0.25;
        c.fillRect(f.x + 2 + i * Math.floor((f.w - 4) / 3), f.y + Math.floor(f.h / 2), 2, 2);
      }
      c.globalAlpha = 1;
    } else if (phase === 1) {
      // sine scan
      for (let x = 0; x < f.w; x++) {
        const y = f.y + Math.floor(f.h / 2 + Math.sin(x * 0.6 + t * 0.012) * (f.h / 2 - 1));
        c.fillRect(f.x + x, y, 1, 1);
      }
    } else if (phase === 2) {
      // spinning eye
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      for (let i = 0; i < 6; i++) {
        const a = t * 0.008 + (i * Math.PI) / 3;
        c.globalAlpha = 0.35 + i / 10;
        c.fillRect(Math.round(cx + Math.cos(a) * (f.h / 2 - 1)), Math.round(cy + Math.sin(a) * (f.h / 2 - 1)), 1, 1);
      }
      c.globalAlpha = 1;
      c.fillRect(Math.round(cx), Math.round(cy), 1, 1);
    } else {
      // binary rain
      const seed = Math.floor(t / 120);
      for (let x = 0; x < f.w; x += 2) {
        for (let y = 0; y < f.h; y += 2) {
          if (hash(x * 31 + y * 17 + seed * 7) > 0.72) c.fillRect(f.x + x, f.y + y, 1, 1);
        }
      }
    }
  }

  private tintFace(c: CanvasRenderingContext2D, f: Rect, color: string, t: number) {
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = color;
    c.globalAlpha = 0.65 + Math.sin(t * 0.02) * 0.2;
    c.fillRect(f.x - 1, f.y - 1, f.w + 2, f.h + 2);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  private sprinkle(c: CanvasRenderingContext2D, color: string, n: number) {
    c.fillStyle = color;
    for (let i = 0; i < n; i++) c.fillRect(Math.floor(Math.random() * this.w), Math.floor(Math.random() * this.h), 1 + Math.floor(Math.random() * 3), 1);
  }

  private drawGlitched(ctx: CanvasRenderingContext2D, t: number) {
    const src = this.scratch;
    // chromatic offsets
    ctx.globalAlpha *= 0.55;
    ctx.globalCompositeOperation = 'lighter';
    const o = 2 + Math.floor(Math.random() * 2);
    ctx.drawImage(src, -o, 0);
    ctx.drawImage(src, o, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha /= 0.55;
    ctx.drawImage(src, 0, 0);
    // displaced slices
    const slices = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < slices; i++) {
      const y = Math.floor(Math.random() * this.h);
      const h = 2 + Math.floor(Math.random() * 7);
      const shift = Math.round((Math.random() - 0.5) * 14);
      ctx.clearRect(0, y, this.w, h);
      ctx.drawImage(src, 0, y, this.w, h, shift, y, this.w, h);
    }
    if (Math.floor(t / 90) % 3 === 0) {
      ctx.fillStyle = 'rgba(168,121,255,0.5)';
      ctx.fillRect(0, Math.floor(Math.random() * this.h), this.w, 1);
    }
  }

  private drawIcon(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, scale: number) {
    const r = this.atlas.ui.items[name];
    if (!r) return;
    const w = Math.round(r.w * scale);
    const h = Math.round(r.h * scale);
    ctx.drawImage(this.atlas.uiImage, r.x, r.y, r.w, r.h, Math.round(x - w / 2), Math.max(0, Math.round(y)), w, h);
  }

  private drawZzz(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, motion: boolean) {
    for (let i = 0; i < 3; i++) {
      const p = motion ? ((t / 2400 + i / 3) % 1) : i / 3;
      const size = 3 + i;
      const zx = Math.round(x + p * 14 + Math.sin(p * 6) * 2);
      const zy = Math.round(y - p * 26);
      ctx.globalAlpha = 1 - p;
      ctx.fillStyle = LAVENDER;
      ctx.fillRect(zx, zy, size, 1);
      for (let k = 1; k < size - 1; k++) ctx.fillRect(zx + size - 1 - k, zy + k, 1, 1);
      ctx.fillRect(zx, zy + size - 1, size, 1);
    }
    ctx.globalAlpha = 1;
  }

  private drawMicBars(ctx: CanvasRenderingContext2D, x: number, y: number, level: number) {
    ctx.fillStyle = PURPLE;
    for (let i = 0; i < 3; i++) {
      const h = 2 + Math.round(level * (6 + i * 3) * (0.6 + 0.4 * Math.random()));
      ctx.fillRect(x + i * 3, y - h, 2, h);
    }
  }
}

function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
