import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { api, errorText } from '../lib/ipc';
import type { ChatEvent, PermissionRequest, Settings, SpeakerInfo, Transcript, VoiceInfo } from '../lib/types';
import { prettyShortcut } from '../lib/shortcuts';
import { settingsStore } from '../lib/useSettings';
import { resolveFx, resolveVoice } from '../audio/presets';
import { SentenceChunker, stripForSpeech } from '../audio/speechText';
import { ttsPlayer } from '../audio/ttsPlayer';
import { VoiceController } from '../voice/voiceController';
import type { CompanionMachine } from './machine';
import { friendlyError, greeting, pickRemark, pokeLine, reactionFor, WAKE_LINES, type FixPage } from './reactions';
import {
  askNameHint,
  askStranger,
  greetOwner,
  greetStranger,
  INTRO_LINES,
  nameRetry,
  ownerMemory,
  ownerRefused,
  ownerSoundedDifferent,
  parseNameAnswer,
  sameName,
  strangerMemory,
  strangerRefused,
} from './intro';

/** `ask` = Noli is talking to you directly (intro, "who's speaking?"); always shown. */
export type BubbleKind = 'speech' | 'transcript' | 'error' | 'remark' | 'confirm' | 'status' | 'ask';

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
  /** small print under the text (e.g. how to answer) */
  hint?: string;
}

/** Noli asked something and the next thing said or typed is the answer. */
type Awaiting =
  | { kind: 'owner-name'; tries: number }
  | { kind: 'speaker-name'; tries: number; token: string; utterance: string };

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
  private pendingSpeaker: SpeakerInfo | null = null;
  /** waiting for an answer to a question Noli asked */
  awaiting: Awaiting | null = null;
  private awaitTimer: ReturnType<typeof setTimeout> | null = null;
  private introStarted = false;
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
        onTranscript: (text, speaker) => this.onTranscript(text, speaker),
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
    return (
      !this.chatOpen &&
      this.running.size === 0 &&
      !this.listening &&
      !ttsPlayer.speaking &&
      this.permissions.length === 0 &&
      !this.pendingTranscript &&
      !this.awaiting &&
      !this.holding &&
      !this.machine.spawning
    );
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
      this.maybeIntroduce();
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
        // a question Noli asked stays up (with its hint) until it's answered
        if (!(this.awaiting && this.bubble?.kind === 'ask')) this.say('speech', e.text, 0);
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
    await on<Transcript>('voice://final', (p) => {
      if (p.auto) this.voice.handleAutoTranscript(p.text, p.speaker ?? null);
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
    const s0 = this.settings;
    if (s0 && !s0.profile.introduced) {
      this.maybeIntroduce();
    } else if (s0?.personality.ambientRemarks && s0.general.characterVisible) {
      // after the star-spawn has finished
      setTimeout(() => {
        if (!this.idle || this.bubble) return;
        this.machine.set('happy', performance.now(), 1600);
        this.say('remark', greeting(new Date().getHours()), 6000);
      }, 3200);
    }
  }

  // ---- first meeting ---------------------------------------------------------------

  /** First run (once setup is done and Noli is on screen): introduce itself and ask for a name. */
  maybeIntroduce(delayMs = 3200) {
    const s = this.settings;
    if (!s || this.introStarted || s.profile.introduced || !s.general.onboardingComplete || !s.general.characterVisible) return;
    this.introStarted = true;
    setTimeout(() => void this.introduce(), delayMs);
  }

  private async introduce() {
    const s = this.settings;
    if (!s || s.profile.introduced) return;
    this.wake(performance.now(), false);
    this.machine.set('happy', performance.now(), 1800);
    this.setChatOpen(true);
    this.awaiting = { kind: 'owner-name', tries: 0 };
    this.ask(INTRO_LINES.join(' '), this.answerHint());
  }

  private answerHint() {
    const s = this.settings;
    const voiceOn = !!s?.voice.enabled;
    const key = s?.general.shortcuts.pushToTalk ? prettyShortcut(s.general.shortcuts.pushToTalk) : 'the talk key';
    return s?.voice.mode === 'continuous' && voiceOn ? 'Just say it, or type it below.' : askNameHint(voiceOn && !!s?.general.shortcuts.pushToTalk, key);
  }

  /** Shows (and speaks) something Noli says on its own, outside the AI conversation. */
  private tell(text: string, opts: { sticky?: boolean; hint?: string } = {}) {
    const now = performance.now();
    this.bubble = { kind: 'ask', text, until: opts.sticky ? 0 : now + Math.min(14_000, 4000 + text.length * 55), hint: opts.hint };
    // with the chatbox open the reply panel is what's visible, so put it there too
    this.reply = {
      conversationId: '',
      messageId: `local-${Math.random().toString(36).slice(2)}`,
      text: opts.hint ? `${text}\n\n› ${opts.hint}` : text,
      status: 'done',
      error: null,
      tool: null,
      startedAt: now,
      fix: null,
    };
    if (this.ttsOn()) {
      ttsPlayer.stop();
      this.configureTts();
      ttsPlayer.speak(stripForSpeech(text, true));
    } else {
      this.machine.set('speaking', now);
      setTimeout(() => {
        if (!ttsPlayer.speaking && this.running.size === 0) this.machine.set(this.listening ? 'listening' : 'idle', performance.now());
      }, Math.min(5000, 900 + text.length * 40));
    }
    this.changed();
  }

  private ask(text: string, hint?: string) {
    this.tell(text, { sticky: true, hint });
  }

  /** Says something and waits until it has been spoken, so a following AI reply doesn't cut it off. */
  private async tellAndWait(text: string) {
    this.tell(text);
    const start = performance.now();
    await sleep(250);
    if (!this.ttsOn()) return sleep(Math.min(2500, 700 + text.length * 30));
    while ((ttsPlayer.busy() || ttsPlayer.speaking) && performance.now() - start < 12_000) await sleep(120);
  }

  private clearAwaiting() {
    this.awaiting = null;
    if (this.awaitTimer) clearTimeout(this.awaitTimer);
    this.awaitTimer = null;
    if (this.bubble?.kind === 'ask') this.bubble.until = performance.now() + 4000;
  }

  /** Someone Noli doesn't know is talking: ask who it is before answering. */
  private askWho(utterance: string, token: string) {
    this.awaiting = { kind: 'speaker-name', tries: 0, token, utterance };
    this.machine.set('confused', performance.now(), 1800);
    this.ask(askStranger(), this.chatOpen ? 'Say your name, or type it below.' : undefined);
    if (this.awaitTimer) clearTimeout(this.awaitTimer);
    // nobody answered: let it go quietly
    this.awaitTimer = setTimeout(() => {
      if (this.awaiting?.kind === 'speaker-name') {
        this.clearAwaiting();
        this.clearBubble('ask');
      }
    }, 60_000);
  }

  private async enroll(token: string | null | undefined, name: string, owner: boolean) {
    if (!token || !this.recognitionOn()) return;
    await api.speakerEnroll(token, name, owner).catch((e) => console.warn('speaker enroll failed', e));
  }

  private recognitionOn() {
    const s = this.settings;
    return !!s?.voice.speakerRecognition && !!s.privacy.memoryEnabled;
  }

  private async remember(fact: string) {
    if (this.settings?.privacy.memoryEnabled) await api.memoryAdd(fact).catch(() => {});
  }

  /** Handles the answer to whatever Noli asked. */
  private async answer(text: string, speaker: SpeakerInfo | null) {
    const a = this.awaiting;
    if (!a) return;
    const parsed = parseNameAnswer(text);
    const now = performance.now();
    this.say('transcript', `“${text}”`, 2500);
    if (a.kind === 'owner-name') {
      if (parsed.kind === 'name') {
        this.clearAwaiting();
        await settingsStore.update((d) => {
          d.profile.userName = parsed.name;
          d.profile.introduced = true;
        });
        await this.remember(ownerMemory(parsed.name));
        // answered by voice: that voice is the owner's
        if (speaker && speaker.status !== 'known' && speaker.status !== 'likely') await this.enroll(speaker.token, parsed.name, true);
        this.machine.set('happy', now, 2400);
        this.tell(greetOwner(parsed.name));
      } else if (parsed.kind === 'refuse' || a.tries >= 2) {
        this.clearAwaiting();
        await settingsStore.update((d) => void (d.profile.introduced = true));
        this.machine.set(parsed.kind === 'refuse' ? 'sad' : 'confused', now, 1800);
        this.tell(parsed.kind === 'refuse' ? ownerRefused : "We'll get there. Tell me your name whenever you like.");
      } else {
        a.tries++;
        this.machine.set('confused', now, 1400);
        this.ask(nameRetry(), this.answerHint());
      }
      return;
    }

    // someone unfamiliar was asked who they are
    const owner = this.settings?.profile.userName?.trim() || null;
    const isOwner = parsed.kind === 'self' || (parsed.kind === 'name' && sameName(parsed.name, owner));
    if (isOwner && owner) {
      this.clearAwaiting();
      // the owner sounding different (a cold, a new mic): learn this version of their voice
      await this.enroll(a.token, owner, true);
      this.machine.set('happy', now, 1600);
      await this.tellAndWait(ownerSoundedDifferent(owner));
      await this.send(a.utterance, owner);
    } else if (parsed.kind === 'name') {
      this.clearAwaiting();
      await this.enroll(a.token, parsed.name, false);
      // the answer is in their voice too, unless someone we know answered for them
      if (speaker && (speaker.status === 'unknown' || speaker.status === 'new')) await this.enroll(speaker.token, parsed.name, false);
      await this.remember(strangerMemory(parsed.name, owner));
      this.machine.set('happy', now, 1800);
      await this.tellAndWait(greetStranger(parsed.name));
      await this.send(a.utterance, parsed.name);
    } else if (parsed.kind === 'refuse' || a.tries >= 1) {
      this.clearAwaiting();
      await this.tellAndWait(strangerRefused);
      await this.send(a.utterance, null);
    } else {
      a.tries++;
      this.ask("Sorry, who's that? Just your name.");
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
    if (this.awaiting) {
      // typed while Noli waits for a name: that's the answer
      await this.answer(text, null);
      return true;
    }
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

  private onTranscript(text: string, speaker: SpeakerInfo | null) {
    if (this.awaiting) {
      void this.answer(text, speaker);
      return;
    }
    if (this.settings?.voice.confirmBeforeSend) {
      this.pendingTranscript = text;
      this.pendingSpeaker = speaker;
      this.say('confirm', text);
      this.machine.set('confused', performance.now(), 1200);
      return;
    }
    void this.routeVoice(text, speaker);
  }

  async confirmPending(send: boolean) {
    const t = this.pendingTranscript;
    const sp = this.pendingSpeaker;
    this.pendingTranscript = null;
    this.pendingSpeaker = null;
    this.clearBubble('confirm');
    if (send && t) await this.routeVoice(t, sp);
  }

  /** Decides who said a voice message before passing it to the AI. */
  private async routeVoice(text: string, speaker: SpeakerInfo | null) {
    const s = this.settings;
    if (!speaker || !s || !this.recognitionOn()) return this.send(text, null);
    const owner = s.profile.userName.trim();
    switch (speaker.status) {
      case 'new':
        // nobody's voice is known yet: the first voice heard is the owner's
        if (owner) await this.enroll(speaker.token, owner, true);
        return this.send(text, owner || null);
      case 'unknown':
        if (speaker.token && s.profile.introduced) return this.askWho(text, speaker.token);
        return this.send(text, null);
      case 'known':
      case 'likely':
        return this.send(text, speaker.name);
      default:
        return this.send(text, null);
    }
  }

  private async send(text: string, speaker: string | null) {
    this.say('transcript', `“${text}”`, 4000);
    try {
      await api.chatSend(text, null, 'voice', speaker);
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
    if (this.bubble?.kind === 'speech' && !this.awaiting) this.bubble.until = now + Math.min(12_000, 3000 + this.bubble.text.length * 45);
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
    if (this.awaitTimer) clearTimeout(this.awaitTimer);
    if (this.remarkTimer) clearTimeout(this.remarkTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    ttsPlayer.dispose();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
