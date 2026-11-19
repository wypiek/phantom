const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** Single modifier keys usable on their own for push-to-talk (KeyboardEvent.code values). */
export const MODIFIER_CODES = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'];

function modifierName(code: string, mac: boolean): string {
  const side = code.endsWith('Left') ? 'Left' : 'Right';
  const base = code.replace(/(Left|Right)$/, '');
  const names: Record<string, string> = mac
    ? { Control: '⌃ Control', Alt: '⌥ Option', Shift: '⇧ Shift', Meta: '⌘ Command' }
    : { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };
  return `${side} ${names[base] ?? base}`;
}

/** "CommandOrControl+Shift+Space" → "⌘⇧Space" (macOS) or "Ctrl+Shift+Space"; "ControlLeft" → "Left ⌃ Control". */
export function prettyShortcut(accel: string, mac = isMac): string {
  if (!accel) return '';
  if (MODIFIER_CODES.includes(accel)) return modifierName(accel, mac);
  return accel
    .split('+')
    .map((k) => {
      if (k === 'CommandOrControl' || k === 'CmdOrCtrl') return mac ? '⌘' : 'Ctrl';
      if (k === 'Shift') return mac ? '⇧' : 'Shift';
      if (k === 'Alt' || k === 'Option') return mac ? '⌥' : 'Alt';
      if (k === 'Control' || k === 'Ctrl') return mac ? '⌃' : 'Ctrl';
      return k;
    })
    .join(mac ? '' : '+');
}
