import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { api, errorText } from '../lib/ipc';
import type { ChatEvent, PermissionRequest, Settings, VoiceInfo } from '../lib/types';
import { settingsStore } from '../lib/useSettings';
import { resolveFx, resolveVoice } from '../audio/presets';
import { SentenceChunker, stripForSpeech } from '../audio/speechText';
import { ttsPlayer } from '../audio/ttsPlayer';
import { VoiceController } from '../voice/voiceController';
import type { CompanionMachine } from './machine';
import { friendlyError, greeting, pickRemark, pokeLine, reactionFor, WAKE_LINES, type FixPage } from './reactions';

export type BubbleKind = 'speech' | 'transcript' | 'error' | 'remark' | 'confirm' | 'status';

/** The latest reply, shown in full above the chatbox. */
export interface Reply {
  conversationId: string;
  messageId: string;
  text: string;
  status: 'streaming' | 'done' | 'error' | 'cancelled';
  error: string | null;
  tool: string | null;
  /** performance.now() when the request started */
  startedAt: number;
  /** settings page that fixes the error, if any */
  fix: FixPage | null;
}
export interface Bubble {
  kind: BubbleKind;
  text: string;
  /** auto-hide timestamp (ms, performance.now) — 0 = sticky */
  until: number;
  /** settings page that fixes an error bubble */
  fix?: FixPage | null;
}

type UiListener = () => void;

/**
 * The companion's brain: routes chat stream events, voice input and speech
 * output into the animation state machine and the speech bubble.
 */
export class Brain {
  bubble: Bubble | null = null;
  reply: Reply | null = null;
  chatOpen = false;
  permissions: PermissionRequest[] = [];
  private expanded = false;
  private pttTimer: ReturnType<typeof setTimeout> | null = null;
  private pttHeldKey = false;
  micLevel = 0;
  listening = false;
  pendingTranscript: string | null = null;
  readonly voice: VoiceController;
  private chunkers = new Map<string, SentenceChunker>();
  private muted = new Set<string>();
  private running = new Set<string>();
  private lastText = new Map<string, string>();
  private unlisten: UnlistenFn[] = [];
  private ui = new Set<UiListener>();
  private systemVoices: VoiceInfo[] = [];
  private remarkTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsErrorShown = false;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private pokes: number[] = [];
  /** true while the user holds the mouse on Noli (stops wandering) */
  holding = false;

  constructor(private machine: CompanionMachine) {
    this.voice = new VoiceController(
      {
        onTranscript: (text) => this.onTranscript(text),
        onEmpty: () => this.say('status', "I didn't catch that.", 2500),
        onError: (msg) => this.fail(msg),
        onInterrupt: () => this.interrupt(),
      },
      () => settingsStore.current,
    );
  }

  private get settings(): Settings | null {
    return settingsStore.current;
  }

  onUi(l: UiListener) {
    this.ui.add(l);
    return () => this.ui.delete(l);
  }
  private changed() {
    this.ui.forEach((l) => l());
  }

  say(kind: BubbleKind, text: string, ms = 0) {
    if (!this.settings?.appearance.showSpeechBubble && (kind === 'speech' || kind === 'remark')) return;
    this.bubble = { kind, text, until: ms ? performance.now() + ms : 0 };
    this.changed();
  }
  clearBubble(kind?: BubbleKind) {
    if (!kind || this.bubble?.kind === kind) {
      this.bubble = null;
      this.changed();
    }
  }

  private fail(msg: string) {
    const f = friendlyError(msg);
    this.machine.set('error', performance.now(), 2600);
    this.say('error', f.text, f.fix ? 12000 : 7000);
    if (this.bubble) this.bubble.fix = f.fix;
  }

  /** Opens the settings page that fixes the current error. */
  openFix(page: FixPage) {
    void api.openWindow('settings', page);
  }

  /** Nothing else going on: free to walk around or mutter. */
  get idle() {
    return !this.chatOpen && this.running.size === 0 && !this.listening && !ttsPlayer.speaking && this.permissions.length === 0 && !this.pendingTranscript && !this.holding;
  }

  /** Wakes Noli for user interaction; grumbles if he was asleep. */
  private wake(now: number, grumble: boolean) {
    const wasAsleep = this.machine.base === 'sleeping';
    this.machine.touch(now);
    if (wasAsleep && grumble) this.say('remark', WAKE_LINES[Math.floor(Math.random() * WAKE_LINES.length)], 3500);
    return wasAsleep;
  }

  /** Night owls get a sleepier Noli. */
  private syncSleepiness() {
    const h = new Date().getHours();
    this.machine.setOptions({ sleepAfterMs: h < 6 ? 3 * 60_000 : 7 * 60_000 });
  }

  async start() {
    await settingsStore.load();
    this.configureTts();
    api.ttsVoices().then((v) => {
      this.systemVoices = v;
      this.configureTts();
    }).catch(() => {});
    settingsStore.subscribe(() => {
      this.configureTts();
      this.machine.setOptions({ idleVariety: !!this.settings?.appearance.idleAnimations && !this.settings?.appearance.reducedMotion });
      void this.voice.sync();
      this.scheduleRemark();
    });

    ttsPlayer.on((e) => {
      const now = performance.now();
      if (e.type === 'start') {
        if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
        this.machine.set('speaking', now);
      } else if (e.type === 'phrase' && e.text) {
        this.say('speech', e.text, 0);
      } else if (e.type === 'end') {
        this.afterSpeech();
      } else if (e.type === 'error' && e.text) {
        if (!this.ttsErrorShown) {
          this.ttsErrorShown = true;
          this.say('error', `Voice failed: ${e.text}`, 6000);
        }
      }
    });

    const on = async <T,>(name: string, fn: (p: T) => void) => this.unlisten.push(await listen<T>(name, (e) => fn(e.payload)));
    await on<ChatEvent>('chat://event', (e) => this.onChat(e));
    await on<{ listening: boolean; phase: string }>('voice://state', (s) => {
      const now = performance.now();
      this.listening = s.listening;
      if (s.listening && (s.phase === 'speech' || this.voice.mode === 'push-to-talk')) {
        this.machine.set('listening', now);
        if (this.voice.mode === 'push-to-talk' && !this.pttHeldKey) this.say('transcript', 'Listening…');
      } else if (s.phase === 'transcribing') {
        this.machine.set('thinking', now);
      } else if (!s.listening && this.running.size === 0 && !ttsPlayer.speaking) {
        this.machine.set('idle', now);
        if (this.bubble?.kind === 'transcript' && this.bubble.text === 'Listening…') this.clearBubble();
      } else if (s.listening && s.phase === 'idle' && this.voice.mode === 'continuous' && this.running.size === 0 && !ttsPlayer.speaking) {
        this.machine.set('idle', now);
      }
      this.changed();
    });
    await on<number>('voice://level', (l) => {
      this.micLevel = l;
    });
    await on<{ text: string }>('voice://partial', (p) => this.say('transcript', `“${p.text}”`));
    await on<{ text: string; auto: boolean }>('voice://final', (p) => {
      if (p.auto) this.voice.handleAutoTranscript(p.text);
    });
    await on<string>('voice://error', (m) => this.fail(m));
    await on<null>('voice://barge-in', () => this.interrupt());
    await on<boolean | { pressed: boolean; heldMs?: number; chord?: boolean }>('shortcut://ptt', (p) => {
      void ttsPlayer.unlock();
      const ev = typeof p === 'boolean' ? { pressed: p } : p;
      if (ev.pressed) {
        this.pttHeldKey = true;
        // Don't cut PHANTOM off for an accidental tap; interrupt once it's clearly a hold.
        void this.voice.pttDown({ interrupt: false });
        if (this.pttTimer) clearTimeout(this.pttTimer);
        this.pttTimer = setTimeout(() => {
          if (!this.pttHeldKey) return;
          this.interrupt();
          if (this.voice.mode === 'push-to-talk') this.say('transcript', 'Listening…');
        }, 350);
      } else {
        this.pttHeldKey = false;
        if (this.pttTimer) clearTimeout(this.pttTimer);
        if (ev.chord || (ev.heldMs !== undefined && ev.heldMs < 450)) void this.voice.pttAbort();
        else void this.voice.pttUp();
      }
    });
    await on<PermissionRequest>('permission://request', (r) => {
      this.permissions = [...this.permissions.filter((x) => x.id !== r.id), r];
      this.machine.set('confused', performance.now(), 1500);
      this.syncExpanded();
      this.changed();
    });
    await on<string>('permission://resolved', (id) => {
      this.permissions = this.permissions.filter((x) => x.id !== id);
      this.syncExpanded();
      this.changed();
    });
    this.permissions = await api.permissionPending().catch(() => []);
    await on<{ action: string }>('voice://request', (r) => {
      void ttsPlayer.unlock();
      if (r.action === 'toggle') void this.voice.toggle();
      if (r.action === 'start') void this.voice.pttDown();
      if (r.action === 'stop') void this.voice.pttUp();
      if (r.action === 'cancel') void this.voice.cancel();
      if (r.action === 'continuous-toggle') void this.voice.toggleContinuous();
    });
    await on<{ action: string; text?: string; voice?: string; engine?: string }>('tts://request', (r) => {
      if (r.action === 'stop') ttsPlayer.stop();
      if (r.action === 'preview' && r.text) {
        ttsPlayer.stop();
        this.configureTts();
        ttsPlayer.speak(r.text);
      }
    });
    await on<string>('companion://command', (c) => this.command(c));

    void this.voice.sync();
    this.scheduleRemark();
    this.syncSleepiness();
    this.clockTimer = setInterval(() => this.syncSleepiness(), 60_000);
    if (this.settings?.personality.ambientRemarks && this.settings.general.characterVisible) {
      setTimeout(() => {
        if (!this.idle || this.bubble) return;
        this.machine.set('happy', performance.now(), 1600);
        this.say('remark', greeting(new Date().getHours()), 6000);
      }, 2500);
    }
  }

  command(c: string) {
    const now = performance.now();
    const moods = ['idle', 'listening', 'thinking', 'speaking', 'happy', 'sad', 'angry', 'confused', 'sleeping', 'scared', 'glitch', 'error', 'vanish'];
    if (c === 'chatbox-open') return this.setChatOpen(true);
    if (c === 'chatbox-toggle') return this.setChatOpen(!this.chatOpen);
    if (c === 'poke') {
      if (this.wake(now, true)) return this.machine.set('scared', now, 1200);
      this.pokes = [...this.pokes.filter((t) => now - t < 8000), now];
      const n = this.pokes.length;
      const line = pokeLine(n);
      const quiet = this.running.size === 0 && !ttsPlayer.speaking && this.permissions.length === 0;
      if (n >= 6) {
        this.machine.set('angry', now, 2400);
        this.pokes = [];
      } else if (n >= 4) {
        this.machine.set('confused', now, 1500);
      } else {
        const r = Math.random();
        if (r < 0.55) this.machine.oneShot('poke', now);
        else if (r < 0.75) this.machine.set('glitch', now, 700);
        else if (r < 0.9) this.machine.set('scared', now, 1400);
        else this.machine.set('happy', now, 1800);
      }
      if (line && quiet) this.say('remark', line, 3500);
    } else if (moods.includes(c)) {
      this.machine.set(c as never, now);
    }
  }

  get busy() {
    return this.running.size > 0;
  }

  setChatOpen(open: boolean) {
    this.chatOpen = open;
    if (open) this.wake(performance.now(), false);
    this.syncExpanded();
    this.changed();
  }

  private syncExpanded() {
    const want = this.chatOpen || this.permissions.length > 0;
    if (want !== this.expanded) {
      this.expanded = want;
      void api.companionSetExpanded(want);
    }
  }

  async sendText(text: string) {
    void ttsPlayer.unlock();
    try {
      await api.chatSend(text, null, 'text');
      return true;
    } catch (e) {
      this.fail(errorText(e));
      return false;
    }
  }

  async answerPermission(id: string, allow: boolean, remember = false) {
    await api.permissionRespond(id, allow, remember).catch(() => {});
    this.permissions = this.permissions.filter((x) => x.id !== id);
    this.syncExpanded();
    this.changed();
  }

  async retry() {
    if (!this.reply) return;
    try {
      await api.chatRegenerate(this.reply.conversationId);
    } catch (e) {
      this.fail(errorText(e));
    }
  }

  stopAll() {
    ttsPlayer.stop();
    void api.chatCancelAll();
  }

  configureTts() {
    const s = this.settings;
    if (!s) return;
    const fx = resolveFx(s.tts.preset, s.tts.fx, s.tts.customPresets ?? {});
    const voice = s.tts.engine === 'system' ? resolveVoice(s.tts.systemVoice, s.tts.preset, this.systemVoices.map((v) => v.name)) : '';
    ttsPlayer.configure({ fx, voice, engine: s.tts.engine });
  }

  /** Stop talking now (user interrupted). The text answer keeps streaming in chat. */
  interrupt() {
    for (const id of this.running) this.muted.add(id);
    ttsPlayer.stop();
  }

  private onTranscript(text: string) {
    if (this.settings?.voice.confirmBeforeSend) {
      this.pendingTranscript = text;
      this.say('confirm', text);
      this.machine.set('confused', performance.now(), 1200);
      return;
    }
    void this.send(text);
  }

  async confirmPending(send: boolean) {
    const t = this.pendingTranscript;
    this.pendingTranscript = null;
    this.clearBubble('confirm');
    if (send && t) await this.send(t);
  }

  private async send(text: string) {
    this.say('transcript', `“${text}”`, 4000);
    try {
      await api.chatSend(text, null, 'voice');
    } catch (e) {
      this.fail(errorText(e));
    }
  }

  private ttsOn() {
    return !!this.settings?.tts.enabled;
  }

  private onChat(e: ChatEvent) {
    const now = performance.now();
    this.machine.touch(now);
    switch (e.kind) {
      case 'start': {
        this.reply = { conversationId: e.conversationId, messageId: e.messageId, text: '', status: 'streaming', error: null, tool: null, startedAt: now, fix: null };
        if (this.waitTimer) clearTimeout(this.waitTimer);
        // chatbox closed and nothing heard yet: show that Noli is working on it
        this.waitTimer = setTimeout(() => {
          if (this.reply?.messageId === e.messageId && !this.reply.text && !this.chatOpen && !this.bubble) this.say('status', 'thinking…');
        }, 2500);
        this.ttsErrorShown = false;
        this.running.add(e.messageId);
        this.chunkers.set(e.messageId, new SentenceChunker());
        this.lastText.set(e.messageId, '');
        // a new reply supersedes anything still being spoken
        ttsPlayer.stop();
        this.machine.set('listening', now);
        if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
        this.thinkingTimer = setTimeout(() => this.machine.set('thinking', performance.now()), 650);
        break;
      }
      case 'delta': {
        if (!e.delta) break;
        if (this.bubble?.kind === 'status' && this.bubble.text === 'thinking…') this.clearBubble();
        if (this.reply?.messageId === e.messageId) {
          this.reply = { ...this.reply, text: this.reply.text + e.delta, tool: null };
          this.changed();
        }
        this.lastText.set(e.messageId, (this.lastText.get(e.messageId) ?? '') + e.delta);
        const speak = this.ttsOn() && !this.muted.has(e.messageId);
        const chunker = this.chunkers.get(e.messageId);
        if (speak && chunker) {
          for (const phrase of chunker.push(e.delta)) ttsPlayer.speak(phrase);
        } else if (!speak) {
          // silent mode: animate the mouth and show the tail of the text
          if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
          this.machine.set('speaking', now);
          const tail = stripForSpeech(this.lastText.get(e.messageId) ?? '', true).trim().slice(-160);
          this.say('speech', tail);
        }
        break;
      }
      case 'activity': {
        const a = e.activity;
        if (a && a.kind === 'tool' && a.state === 'running' && this.reply?.messageId === e.messageId) {
          this.reply = { ...this.reply, tool: `${a.label}${a.detail ? `: ${a.detail}` : ''}` };
          this.changed();
        }
        if (a && a.kind === 'tool' && a.state === 'running') {
          if (!ttsPlayer.speaking) this.machine.set('thinking', now);
          this.say('status', `⚙ ${a.label}${a.detail ? `: ${a.detail}` : ''}`, 5000);
        }
        if (a && a.state === 'denied') this.machine.set('sad', now, 1800);
        break;
      }
      case 'done': {
        if (this.bubble?.kind === 'status' && this.bubble.text === 'thinking…') this.clearBubble();
        if (this.reply?.messageId === e.messageId) this.reply = { ...this.reply, text: e.content ?? this.reply.text, status: 'done', tool: null };
        this.running.delete(e.messageId);
        const chunker = this.chunkers.get(e.messageId);
        if (this.ttsOn() && !this.muted.has(e.messageId) && chunker) {
          for (const phrase of chunker.flush()) ttsPlayer.speak(phrase);
        }
        this.chunkers.delete(e.messageId);
        this.muted.delete(e.messageId);
        if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
        const text = e.content ?? this.lastText.get(e.messageId) ?? '';
        this.lastText.set(e.messageId, text);
        if (!ttsPlayer.busy()) this.afterSpeech(e.messageId);
        else this.pendingReaction = text;
        break;
      }
      case 'error': {
        if (this.reply?.messageId === e.messageId) {
          const f = friendlyError(e.error ?? 'Something went wrong.');
          this.reply = { ...this.reply, status: 'error', error: f.text, fix: f.fix, tool: null };
        }
        this.running.delete(e.messageId);
        this.chunkers.delete(e.messageId);
        if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
        ttsPlayer.stop();
        this.fail(e.error ?? 'Something went wrong.');
        break;
      }
      case 'cancelled': {
        if (this.reply?.messageId === e.messageId) this.reply = { ...this.reply, text: e.content ?? this.reply.text, status: 'cancelled', tool: null };
        this.running.delete(e.messageId);
        this.chunkers.delete(e.messageId);
        if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
        ttsPlayer.stop();
        this.machine.set('idle', now);
        break;
      }
    }
    this.changed();
  }

  private pendingReaction: string | null = null;

  private afterSpeech(messageId?: string) {
    const now = performance.now();
    if (this.running.size > 0) {
      this.machine.set('thinking', now);
      return;
    }
    this.machine.set(this.voice.listening && this.voice.mode === 'push-to-talk' ? 'listening' : 'idle', now);
    const text = this.pendingReaction ?? (messageId ? this.lastText.get(messageId) : null);
    this.pendingReaction = null;
    if (text) {
      const r = reactionFor(text);
      if (r) this.machine.set(r, now);
    }
    // long lines stay up long enough to read
    if (this.bubble?.kind === 'speech') this.bubble.until = now + Math.min(12_000, 3000 + this.bubble.text.length * 45);
    this.changed();
  }

  private scheduleRemark() {
    if (this.remarkTimer) clearTimeout(this.remarkTimer);
    if (!this.settings?.personality.ambientRemarks) return;
    const delay = (40 + Math.random() * 50) * 60_000;
    this.remarkTimer = setTimeout(() => {
      if (this.idle && !this.bubble && this.machine.base !== 'sleeping') {
        this.machine.set('glitch', performance.now(), 600);
        this.say('remark', pickRemark(), 9000);
      }
      this.scheduleRemark();
    }, delay);
  }

  /** Ask the chat window (if open) to display something. */
  notifyChat(event: string, payload: unknown) {
    void emit(event, payload);
  }

  dispose() {
    this.unlisten.forEach((u) => u());
    if (this.remarkTimer) clearTimeout(this.remarkTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    ttsPlayer.dispose();
  }
}
