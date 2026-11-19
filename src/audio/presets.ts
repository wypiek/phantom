import type { FxParams } from '../lib/types';

export interface VoicePreset {
  id: string;
  label: string;
  description: string;
  fx: FxParams;
  /** Preferred system voices for this preset when the user hasn't picked one. */
  voiceHint: string[];
}

const base: FxParams = {
  pitch: 1,
  speed: 1,
  reverb: 0,
  echo: 0,
  echoTime: 0.2,
  distortion: 0,
  lowpass: 18000,
  bitcrush: 0,
  staticNoise: 0,
  ringMod: 0,
  pauses: 0,
  volume: 1,
};

export const PRESETS: VoicePreset[] = [
  {
    id: 'phantom',
    label: 'PHANTOM',
    description: 'Deep, distorted, dark robotic voice.',
    fx: { ...base, pitch: 0.84, speed: 0.93, reverb: 0.22, echo: 0.12, echoTime: 0.19, distortion: 0.16, lowpass: 5200, bitcrush: 0.14, staticNoise: 0.12, ringMod: 0.08, pauses: 0.35 },
    voiceHint: ['Ralph', 'Daniel', 'Fred', 'Microsoft David Desktop', 'Microsoft David', 'en-us+m3'],
  },
  {
    id: 'whisper',
    label: 'WHISPER',
    description: 'Quiet, breathy, mysterious voice.',
    fx: { ...base, pitch: 0.97, speed: 0.88, reverb: 0.42, echo: 0.18, echoTime: 0.28, distortion: 0.02, lowpass: 4200, bitcrush: 0.04, staticNoise: 0.16, ringMod: 0, pauses: 0.45, volume: 0.9 },
    voiceHint: ['Whisper', 'Daniel', 'Microsoft Zira Desktop', 'en-us+whisper'],
  },
  {
    id: 'terminal',
    label: 'TERMINAL',
    description: 'Old computer voice with digital artifacts.',
    fx: { ...base, pitch: 1.0, speed: 1.0, reverb: 0.08, echo: 0.05, echoTime: 0.12, distortion: 0.22, lowpass: 4600, bitcrush: 0.5, staticNoise: 0.14, ringMod: 0.32, pauses: 0.15 },
    voiceHint: ['Fred', 'Ralph', 'Microsoft David Desktop', 'en-us'],
  },
  {
    id: 'nightmare',
    label: 'NIGHTMARE',
    description: 'Heavily distorted horror voice.',
    fx: { ...base, pitch: 0.7, speed: 0.86, reverb: 0.38, echo: 0.28, echoTime: 0.23, distortion: 0.42, lowpass: 3600, bitcrush: 0.32, staticNoise: 0.24, ringMod: 0.22, pauses: 0.55 },
    voiceHint: ['Ralph', 'Bad News', 'Daniel', 'Microsoft David Desktop', 'en-us+m7'],
  },
  {
    id: 'normal',
    label: 'NORMAL',
    description: 'Original, unprocessed voice.',
    fx: { ...base },
    voiceHint: [],
  },
];

export const DEFAULT_PRESET = 'phantom';

export function presetById(id: string): VoicePreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Effective effect parameters for the current settings. */
export function resolveFx(presetId: string, fx: FxParams | null, custom: Record<string, FxParams>): FxParams {
  if (fx) return { ...base, ...fx };
  if (custom[presetId]) return { ...base, ...custom[presetId] };
  return { ...(presetById(presetId) ?? PRESETS[0]).fx };
}

/** Picks a system voice: explicit choice → preset hint → engine default (""). */
export function resolveVoice(explicit: string, presetId: string, available: string[]): string {
  if (explicit) return explicit;
  const hints = presetById(presetId)?.voiceHint ?? [];
  const lower = available.map((v) => v.toLowerCase());
  for (const h of hints) {
    const i = lower.indexOf(h.toLowerCase());
    if (i >= 0) return available[i];
  }
  return '';
}

/**
 * Pitch is applied as playback rate, which also speeds audio up. The engine is
 * asked to speak at speed/pitch so the final tempo equals the requested speed.
 */
export function engineRate(fx: FxParams): number {
  const r = fx.speed / Math.max(0.3, fx.pitch);
  return Math.min(3, Math.max(0.3, r));
}

export const FX_LIMITS: Record<keyof FxParams, { min: number; max: number; step: number; label: string; unit?: string }> = {
  pitch: { min: 0.55, max: 1.4, step: 0.01, label: 'Pitch', unit: '×' },
  speed: { min: 0.6, max: 1.6, step: 0.01, label: 'Speed', unit: '×' },
  reverb: { min: 0, max: 1, step: 0.01, label: 'Reverb' },
  echo: { min: 0, max: 0.8, step: 0.01, label: 'Echo' },
  echoTime: { min: 0.05, max: 0.6, step: 0.01, label: 'Echo time', unit: 's' },
  distortion: { min: 0, max: 1, step: 0.01, label: 'Distortion' },
  lowpass: { min: 1200, max: 18000, step: 100, label: 'Low-pass', unit: 'Hz' },
  bitcrush: { min: 0, max: 1, step: 0.01, label: 'Bitcrush' },
  staticNoise: { min: 0, max: 1, step: 0.01, label: 'Static' },
  ringMod: { min: 0, max: 1, step: 0.01, label: 'Robot (ring mod)' },
  pauses: { min: 0, max: 1, step: 0.01, label: 'Unnatural pauses' },
  volume: { min: 0, max: 1.5, step: 0.01, label: 'Volume' },
};
