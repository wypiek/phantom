import type { AtlasManifest } from './atlas';

export type Effect = 'breath' | 'mouth' | 'screen' | 'glitch' | 'error' | 'tremble' | 'shake' | 'bob' | 'droop' | 'tilt' | 'fade-out' | 'fade-in' | 'listen';
export type Overlay = 'exclaim' | 'question' | 'heart' | 'zzz' | null;

export interface Clip {
  name: string;
  frames: number[];
  fps: number;
  loop: boolean;
  effects: Effect[];
  overlay: Overlay;
}

/**
 * Maps PHANTOM's behaviour states onto the Noli sheet sections
 * (see public/sprites/noli-animations.json). Frame numbers are positions
 * within each section; marks like "?" and "!" are already drawn into some frames.
 */
export function buildClips(m: AtlasManifest): Record<string, Clip> {
  const s = m.sections;
  const pick = (sec: keyof typeof s, idx: number[]) => idx.map((i) => s[sec][Math.min(i, s[sec].length - 1)]);
  const c = (name: string, frames: number[], fps: number, loop: boolean, effects: Effect[] = [], overlay: Overlay = null): Clip => ({ name, frames, fps, loop, effects, overlay });
  return {
    idle: c('idle', s.idle_loop, 6, true),
    idle_alt: c('idle_alt', s.idle_actions, 3, true, ['breath']),
    look_around: c('look_around', pick('look_directions', [0, 1, 2, 3, 4, 5, 0]), 2.5, false, ['breath']),
    listening: c('listening', s.idle_loop, 6, true, ['listen'], 'exclaim'),
    thinking: c('thinking', pick('look_directions', [0, 1, 0, 3, 4, 3]), 2, true, ['screen']),
    speaking: c('speaking', s.talk_loop, 8, true, ['mouth']),
    happy: c('happy', pick('emotions', [2, 3, 0, 3]), 2.5, true, ['bob'], 'heart'),
    sad: c('sad', pick('hurt_sad', [0, 1]), 1, true, ['droop']),
    angry: c('angry', [s.emotions[1], s.special_states[3], s.emotions[1], s.special_states[4]], 3, true, ['shake']),
    confused: c('confused', pick('thinking_confused', [2, 3]), 1.2, true),
    scared: c('scared', [s.emotions[4], s.emotions[5], s.reacting[4]], 5, true, ['tremble']),
    lie_down: c('lie_down', pick('follow_idle_sits', [1, 2, 3, 5]), 3, false),
    sleeping: c('sleeping', [s.follow_idle_sits[5], s.extra_sad[4]], 0.7, true, [], 'zzz'),
    stand_up: c('stand_up', [...pick('follow_idle_sits', [3, 2, 1]), s.idle_loop[0]], 4, false),
    glitch: c('glitch', [s.special_states[1], s.special_states[2], s.idle[0], s.special_states[1]], 10, true, ['glitch']),
    error: c('error', pick('special_states', [3, 4]), 3, true, ['error', 'shake']),
    vanish_out: c('vanish_out', s.teleport_pixels, 6, false, ['fade-out']),
    vanish_in: c('vanish_in', [...s.teleport_pixels].reverse(), 7, false, ['fade-in']),
    poke: c('poke', [s.reacting[0], s.interactions[1], ...pick('gestures', [1, 2])], 4, false),
    walk: c('walk', s.movement, 9, true),
    sit: c('sit', pick('follow_idle_sits', [1, 2]), 0.8, true, ['breath']),
  };
}
