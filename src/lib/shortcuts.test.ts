import { describe, expect, it } from 'vitest';
import { prettyShortcut } from './shortcuts';

describe('prettyShortcut', () => {
  it('formats combos for macOS and others', () => {
    expect(prettyShortcut('CommandOrControl+Shift+Space', true)).toBe('⌘⇧Space');
    expect(prettyShortcut('CommandOrControl+Shift+Space', false)).toBe('Ctrl+Shift+Space');
    expect(prettyShortcut('', true)).toBe('');
  });
  it('formats single modifier keys', () => {
    expect(prettyShortcut('ControlLeft', true)).toBe('Left ⌃ Control');
    expect(prettyShortcut('ControlLeft', false)).toBe('Left Ctrl');
    expect(prettyShortcut('AltRight', false)).toBe('Right Alt');
  });
});
