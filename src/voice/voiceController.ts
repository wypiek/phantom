import { api, errorText } from '../lib/ipc';
import type { ListenMode, Settings } from '../lib/types';

export interface VoiceCallbacks {
  /** Called when a transcript should be sent (or confirmed). */
  onTranscript: (text: string) => void;
  onEmpty: () => void;
  onError: (msg: string) => void;
  /** User started talking → stop PHANTOM's speech. */
  onInterrupt: () => void;
}

/**
 * Push-to-talk and continuous listening. Audio capture, VAD and Whisper run in
 * the Rust backend; this class only sequences start/stop and routes results.
 */
export class VoiceController {
  listening = false;
  mode: ListenMode | null = null;
  private busy = false;
  private pttHeld = false;
  private inputKey = '';

  constructor(
    private cb: VoiceCallbacks,
    private getSettings: () => Settings | null,
  ) {}

  private enabled() {
    return !!this.getSettings()?.voice.enabled;
  }

  private aborted = false;

  async pttDown(opts: { interrupt?: boolean } = {}) {
    if (!this.enabled() || this.pttHeld) return;
    this.pttHeld = true;
    this.aborted = false;
    if (opts.interrupt !== false) this.cb.onInterrupt();
    if (this.mode === 'continuous') return; // continuous already listens; PTT just interrupts
    try {
      await api.voiceStart('push-to-talk');
      this.listening = true;
      this.mode = 'push-to-talk';
      // released while the mic was still opening
      if (this.aborted) await this.cancel();
      else if (!this.pttHeld) await this.pttUp(true);
    } catch (e) {
      this.pttHeld = false;
      this.cb.onError(errorText(e));
    }
  }

  async pttUp(force = false) {
    if (!this.pttHeld && !force) return;
    this.pttHeld = false;
    if (this.mode !== 'push-to-talk' || this.busy) return;
    this.busy = true;
    try {
      const res = await api.voiceStop();
      this.listening = false;
      this.mode = null;
      if (res.text.trim()) this.cb.onTranscript(res.text.trim());
      else this.cb.onEmpty();
    } catch (e) {
      this.listening = false;
      this.mode = null;
      this.cb.onError(errorText(e));
    } finally {
      this.busy = false;
    }
  }

  /** Released too quickly (or as part of a key chord): discard without transcribing. */
  async pttAbort() {
    if (!this.pttHeld) return;
    this.pttHeld = false;
    this.aborted = true;
    if (this.mode === 'push-to-talk') await this.cancel();
  }

  /** Click-to-talk: first call starts, second stops and transcribes. */
  async toggle() {
    if (this.mode === 'push-to-talk') return this.pttUp(true);
    if (this.mode === 'continuous') return this.stopContinuous();
    this.pttHeld = false;
    if (!this.enabled()) return this.cb.onError('Voice input is turned off in Settings.');
    this.cb.onInterrupt();
    try {
      await api.voiceStart('push-to-talk');
      this.listening = true;
      this.mode = 'push-to-talk';
    } catch (e) {
      this.cb.onError(errorText(e));
    }
  }

  async startContinuous() {
    if (!this.enabled() || this.mode === 'continuous') return;
    try {
      await api.voiceStart('continuous');
      this.listening = true;
      this.mode = 'continuous';
    } catch (e) {
      this.cb.onError(errorText(e));
    }
  }

  async stopContinuous() {
    if (this.mode !== 'continuous') return;
    await api.voiceStop().catch(() => {});
    this.listening = false;
    this.mode = null;
  }

  async cancel() {
    this.pttHeld = false;
    await api.voiceCancel().catch(() => {});
    this.listening = false;
    this.mode = null;
  }

  /** Continuous-mode utterance finished (event from backend). */
  handleAutoTranscript(text: string) {
    if (this.mode !== 'continuous') return;
    if (text.trim()) this.cb.onTranscript(text.trim());
  }

  /** Turns continuous listening on/off without changing the saved mode. */
  async toggleContinuous() {
    if (this.mode === 'continuous') return this.stopContinuous();
    if (this.mode === 'push-to-talk') await this.cancel();
    return this.startContinuous();
  }

  /** Keep continuous listening in sync with settings. */
  async sync() {
    const s = this.getSettings();
    // a new microphone or gain only applies when capture restarts
    const key = s ? `${s.voice.inputDevice}|${s.voice.inputGain}` : '';
    if (this.inputKey && key !== this.inputKey && this.mode === 'continuous') await this.stopContinuous();
    this.inputKey = key;
    const want = !!s && s.voice.enabled && s.voice.mode === 'continuous';
    if (want && this.mode === null) await this.startContinuous();
    if (!want && this.mode === 'continuous') await this.stopContinuous();
    if (s && !s.voice.enabled && this.mode) await this.cancel();
  }
}
