import { api, errorText } from '../lib/ipc';
import type { FxParams } from '../lib/types';
import { FxChain } from './fxChain';
import { engineRate } from './presets';

export interface SpeakOptions {
  fx: FxParams;
  voice: string;
  engine: 'system' | 'piper';
}

interface QueueItem {
  text: string;
  gen: number;
  audio: Promise<AudioBuffer | null>;
}

type Listener = (e: { type: 'start' | 'end' | 'phrase' | 'error'; text?: string }) => void;

/**
 * Sentence-queued TTS playback through the horror FX chain.
 * - Synthesizes up to 2 phrases ahead while the current one plays.
 * - Exactly one playback stream at a time; `stop()` silences instantly.
 */
export class TtsPlayer {
  private ctx: AudioContext | null = null;
  private chain: FxChain | null = null;
  private queue: QueueItem[] = [];
  private gen = 0;
  private current: AudioBufferSourceNode | null = null;
  private running = false;
  private listeners = new Set<Listener>();
  private opts: SpeakOptions | null = null;
  speaking = false;

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: Parameters<Listener>[0]) {
    this.listeners.forEach((l) => l(e));
  }

  private async ensure(): Promise<FxChain> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.chain = new FxChain(this.ctx);
      await this.chain.ready;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    return this.chain!;
  }

  configure(opts: SpeakOptions) {
    this.opts = opts;
    this.chain?.set(opts.fx);
  }

  /** Queue a phrase. Returns immediately. */
  speak(text: string) {
    if (!this.opts || !text.trim()) return;
    const gen = this.gen;
    const opts = this.opts;
    const item: QueueItem = { text, gen, audio: this.synth(text, opts) };
    this.queue.push(item);
    if (!this.running) void this.loop();
  }

  private async synth(text: string, opts: SpeakOptions): Promise<AudioBuffer | null> {
    try {
      const chain = await this.ensure();
      const wav = await api.ttsSynthesize(text, engineRate(opts.fx), opts.engine, opts.voice);
      return await chain.ctx.decodeAudioData(wav);
    } catch (e) {
      this.emit({ type: 'error', text: errorText(e) });
      return null;
    }
  }

  private async loop() {
    this.running = true;
    const chain = await this.ensure();
    if (this.opts) chain.set(this.opts.fx);
    while (this.queue.length) {
      const item = this.queue[0];
      const buf = await item.audio;
      if (item.gen !== this.gen) {
        // stopped while synthesizing
        continue;
      }
      this.queue.shift();
      if (!buf) continue;
      if (!this.speaking) {
        this.speaking = true;
        chain.speaking(true);
        void api.voiceSetSpeaking(true).catch(() => {});
        this.emit({ type: 'start' });
      }
      this.emit({ type: 'phrase', text: item.text });
      const fx = this.opts?.fx;
      // Occasional digital stutter: replay the first ~90ms once.
      if (fx && Math.random() < fx.pauses * 0.12 && buf.duration > 0.6) {
        await this.play(buf, fx.pitch, 0, 0.09);
        if (item.gen !== this.gen) continue;
      }
      chain.crackle();
      await this.play(buf, fx?.pitch ?? 1);
      if (item.gen !== this.gen) continue;
      // Natural gap, sometimes an unnatural one.
      const p = fx?.pauses ?? 0;
      const gap = 70 + (Math.random() < p * 0.45 ? 280 + Math.random() * 520 : 0);
      if (this.queue.length) await sleep(gap);
    }
    this.running = false;
    this.finish();
  }

  private play(buf: AudioBuffer, rate: number, offset = 0, duration?: number): Promise<void> {
    return new Promise((resolve) => {
      const chain = this.chain!;
      const src = chain.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.connect(chain.input);
      src.onended = () => {
        src.disconnect();
        if (this.current === src) this.current = null;
        resolve();
      };
      this.current = src;
      if (duration !== undefined) src.start(0, offset, duration);
      else src.start(0, offset);
    });
  }

  private finish() {
    if (this.speaking) {
      this.speaking = false;
      this.chain?.speaking(false);
      void api.voiceSetSpeaking(false).catch(() => {});
      this.emit({ type: 'end' });
    }
  }

  /** Stop immediately and drop everything queued. */
  stop() {
    this.gen++;
    this.queue = [];
    if (this.current) {
      try {
        this.current.stop();
      } catch {
        /* already stopped */
      }
      this.current = null;
    }
    this.finish();
  }

  /** Whether more phrases are pending or playing. */
  busy() {
    return this.running || this.queue.length > 0;
  }

  level(): number {
    return this.speaking && this.chain ? this.chain.level() : 0;
  }

  /** Unlocks audio after a user gesture (autoplay policies). */
  async unlock() {
    await this.ensure().catch(() => {});
  }

  dispose() {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.chain = null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared instance for the window that owns audio (the companion). */
export const ttsPlayer = new TtsPlayer();
