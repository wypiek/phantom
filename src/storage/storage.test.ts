import { describe, expect, it } from 'vitest';
import { hideMemoryTags } from './memories';
import { relativeTime } from './conversations';

describe('storage helpers', () => {
  it('hides complete and partial memory tags', () => {
    expect(hideMemoryTags('Hi <remember>x</remember>')).toBe('Hi ');
    expect(hideMemoryTags('Hi <remember>unfinished')).toBe('Hi ');
    expect(hideMemoryTags('Hi <reme')).toBe('Hi ');
    expect(hideMemoryTags('a < b')).toBe('a < b');
  });
  it('formats relative times', () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3h ago');
  });
});
