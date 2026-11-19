import { describe, expect, it } from 'vitest';
import { buildClips } from './clips';
import type { AtlasManifest } from './atlas';
import { CompanionMachine, MOODS } from './machine';
import manifest from '../../public/sprites/phantom-atlas.json';

const clips = buildClips(manifest as unknown as AtlasManifest);
const make = () => new CompanionMachine(clips, { idleVariety: true, sleepAfterMs: 60_000, random: () => 0.3 }, 0);

describe('CompanionMachine', () => {
  it('has a clip for every required state', () => {
    const m = make();
    let t = 0;
    for (const mood of MOODS) {
      t += 10;
      m.set(mood, t);
      const f = m.tick(t + 1);
      expect(f.frame).toBeGreaterThanOrEqual(0);
      expect(f.frame).toBeLessThan(manifest.frames.length);
    }
  });

  it('reaction moods return to the base mood', () => {
    const m = make();
    m.set('thinking', 0);
    m.set('happy', 100, 1000);
    expect(m.tick(500).mood).toBe('happy');
    expect(m.tick(1200).mood).toBe('thinking');
  });

  it('base changes during a reaction apply afterwards', () => {
    const m = make();
    m.set('error', 0, 1000);
    m.set('idle', 200);
    expect(m.tick(300).mood).toBe('error');
    expect(m.tick(1100).mood).toBe('idle');
  });

  it('lies down before sleeping and stands up when woken', () => {
    const m = make();
    m.set('sleeping', 0);
    expect(m.tick(10).clip).toBe('lie_down');
    expect(m.tick(5000).clip).toBe('sleeping');
    expect(m.tick(5000).overlay).toBe('zzz');
    m.set('listening', 6000);
    expect(m.tick(6010).clip).toBe('stand_up');
    expect(m.tick(9000).clip).toBe('listening');
  });

  it('falls asleep after inactivity and wakes on touch', () => {
    const m = make();
    m.tick(1000);
    m.tick(61_000);
    expect(m.base).toBe('sleeping');
    m.touch(70_000);
    expect(m.base).toBe('idle');
  });

  it('vanish fades out, hides, and returns', () => {
    const m = make();
    m.set('vanish', 0, 2000);
    expect(m.tick(100).alpha).toBeLessThan(1);
    let t = 100;
    let sawHidden = false;
    while (t < 6000) {
      const f = m.tick(t);
      if (f.alpha === 0) sawHidden = true;
      t += 50;
    }
    expect(sawHidden).toBe(true);
    const end = m.tick(t);
    expect(end.alpha).toBe(1);
    expect(end.mood).toBe('idle');
  });

  it('cross-fades between clips without jumps', () => {
    const m = make();
    m.tick(0);
    m.set('thinking', 100);
    const f = m.tick(150);
    expect(f.prev).not.toBeNull();
    expect(f.prev!.alpha).toBeGreaterThan(0);
    expect(m.tick(400).prev).toBeNull();
  });
});
