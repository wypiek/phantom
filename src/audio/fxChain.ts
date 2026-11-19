import type { FxParams } from '../lib/types';

/**
 * Real-time horror voice processing graph (Web Audio):
 *
 *  source ─► ring mod ─► bitcrusher ─► distortion ─► high-pass ─► low-pass ─┬─► dry ─────────┐
 *                                                                          ├─► reverb ──────┤
 *                                                                          └─► echo (fb) ───┤
 *  static noise (band-passed, only while speaking) ────────────────────────────────────────┤
 *                                                                        master ◄──────────┘
 *                                                     compressor ◄── master
 *                                                       analyser ◄── compressor ─► speakers
 *
 * All parameters can change while audio plays.
 */
export class FxChain {
  readonly ctx: AudioContext;
  readonly input: GainNode;
  readonly analyser: AnalyserNode;
  private ringDry: GainNode;
  private ringWet: GainNode;
  private ringCarrier: GainNode;
  private ringOsc: OscillatorNode;
  private crusher: AudioWorkletNode | null = null;
  private crusherIn: GainNode;
  private shaper: WaveShaperNode;
  private highpass: BiquadFilterNode;
  private lowpass: BiquadFilterNode;
  private dry: GainNode;
  private reverb: ConvolverNode;
  private reverbWet: GainNode;
  private delay: DelayNode;
  private delayFb: GainNode;
  private delayWet: GainNode;
  private master: GainNode;
  private noiseGain: GainNode;
  private noiseLevel = 0;
  private lastDrive = -1;
  private timeBuf: Float32Array<ArrayBuffer>;
  ready: Promise<void>;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    this.input = g();

    // ring modulation (robotic timbre): wet = input × sine carrier
    this.ringDry = g();
    this.ringWet = g(0);
    this.ringCarrier = g(0);
    this.ringOsc = ctx.createOscillator();
    this.ringOsc.frequency.value = 52;
    this.ringOsc.connect(this.ringCarrier.gain);
    this.ringOsc.start();
    this.input.connect(this.ringDry);
    this.input.connect(this.ringCarrier);
    this.ringCarrier.connect(this.ringWet);

    this.crusherIn = g();
    this.ringDry.connect(this.crusherIn);
    this.ringWet.connect(this.crusherIn);

    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = 70;
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.Q.value = 0.7;

    this.dry = g();
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 2.6, 2.8);
    this.reverbWet = g(0);
    this.delay = ctx.createDelay(1.5);
    this.delayFb = g(0);
    this.delayWet = g(0);
    this.master = g();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.timeBuf = new Float32Array(this.analyser.fftSize);

    // wiring (crusher inserted once its worklet loads)
    this.crusherIn.connect(this.shaper);
    this.shaper.connect(this.highpass);
    this.highpass.connect(this.lowpass);
    this.lowpass.connect(this.dry);
    this.lowpass.connect(this.reverb);
    this.reverb.connect(this.reverbWet);
    this.lowpass.connect(this.delay);
    this.delay.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delay.connect(this.delayWet);
    this.dry.connect(this.master);
    this.reverbWet.connect(this.master);
    this.delayWet.connect(this.master);
    this.master.connect(comp);
    comp.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // background static: looping noise through a band-pass, gated while speaking
    const noise = ctx.createBufferSource();
    noise.buffer = makeNoise(ctx, 3);
    noise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 3200;
    band.Q.value = 0.6;
    this.noiseGain = g(0);
    noise.connect(band);
    band.connect(this.noiseGain);
    this.noiseGain.connect(this.master);
    noise.start();

    this.ready = ctx.audioWorklet
      .addModule('/worklets/bitcrusher.js')
      .then(() => {
        this.crusher = new AudioWorkletNode(ctx, 'phantom-bitcrusher', { outputChannelCount: [1] });
        this.crusherIn.disconnect();
        this.crusherIn.connect(this.crusher);
        this.crusher.connect(this.shaper);
      })
      .catch((e) => console.warn('bitcrusher unavailable, continuing without it', e));
  }

  set(fx: FxParams) {
    const t = this.ctx.currentTime;
    const ramp = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.03);
    ramp(this.ringWet.gain, fx.ringMod * 0.9);
    ramp(this.ringDry.gain, 1 - fx.ringMod * 0.55);
    if (this.crusher) {
      ramp(this.crusher.parameters.get('bits')!, fx.bitcrush <= 0.01 ? 16 : 16 - fx.bitcrush * 11);
      ramp(this.crusher.parameters.get('hold')!, 1 + Math.round(fx.bitcrush * 5));
    }
    if (Math.abs(fx.distortion - this.lastDrive) > 0.005) {
      this.shaper.curve = makeDriveCurve(fx.distortion);
      this.lastDrive = fx.distortion;
    }
    ramp(this.lowpass.frequency, fx.lowpass);
    ramp(this.dry.gain, 1 - fx.reverb * 0.35);
    ramp(this.reverbWet.gain, fx.reverb * 0.85);
    this.delay.delayTime.setTargetAtTime(fx.echoTime, t, 0.05);
    ramp(this.delayFb.gain, Math.min(0.75, fx.echo * 0.9));
    ramp(this.delayWet.gain, fx.echo * 0.7);
    ramp(this.master.gain, fx.volume);
    this.noiseLevel = fx.staticNoise * 0.06;
  }

  /** Fade static in/out with speech. */
  speaking(on: boolean) {
    const t = this.ctx.currentTime;
    this.noiseGain.gain.cancelScheduledValues(t);
    this.noiseGain.gain.setTargetAtTime(on ? this.noiseLevel : 0, t, on ? 0.05 : 0.25);
  }

  /** Random crackle in the static (called per chunk). */
  crackle() {
    if (this.noiseLevel <= 0) return;
    const t = this.ctx.currentTime;
    const g = this.noiseGain.gain;
    g.setValueAtTime(this.noiseLevel * (2 + Math.random() * 2), t);
    g.setTargetAtTime(this.noiseLevel, t + 0.03, 0.04);
  }

  /** 0..1 loudness of what is currently playing (drives the mouth). */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i++) sum += this.timeBuf[i] * this.timeBuf[i];
    return Math.min(1, Math.sqrt(sum / this.timeBuf.length) * 5);
  }
}

function makeDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = amount * 60;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = k < 0.01 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, decay);
      // slightly low-passed noise → darker room
      last = last * 0.55 + (Math.random() * 2 - 1) * 0.45;
      d[i] = last * env;
    }
  }
  return buf;
}

function makeNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    // sparse crackles on top of hiss
    d[i] = (Math.random() * 2 - 1) * 0.6 + (Math.random() < 0.0008 ? (Math.random() * 2 - 1) * 3 : 0);
  }
  return buf;
}
