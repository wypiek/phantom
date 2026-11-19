import { Field, Section, ShortcutInput, Slider, Toggle } from '../../components/ui';
import type { Settings } from '../../lib/types';

type Props = { s: Settings; update: (m: (d: Settings) => void) => Promise<string[]> };

export function General({ s, update }: Props) {
  const g = s.general;
  const set = (m: (d: Settings) => void) => void update(m);
  return (
    <>
      <Section title="Startup">
        <Field label="Launch at startup" hint="Noli wakes up when you log in." inline>
          <Toggle checked={g.launchAtStartup} onChange={(v) => set((d) => void (d.general.launchAtStartup = v))} />
        </Field>
        <Field label="Start minimized" hint="Start hidden in the tray; summon with the shortcut." inline>
          <Toggle checked={g.startMinimized} onChange={(v) => set((d) => void (d.general.startMinimized = v))} />
        </Field>
      </Section>

      <Section title="Character">
        <Field label="Show Noli on the desktop" inline>
          <Toggle checked={g.characterVisible} onChange={(v) => set((d) => void (d.general.characterVisible = v))} />
        </Field>
        <Field label="Size" hint="Height of the creature in pixels.">
          <Slider value={g.characterSize} min={100} max={480} step={10} onChange={(v) => set((d) => void (d.general.characterSize = v))} format={(v) => `${v}px`} label="Character size" />
        </Field>
        <Field label="Opacity">
          <Slider value={g.characterOpacity} min={0.2} max={1} step={0.05} onChange={(v) => set((d) => void (d.general.characterOpacity = v))} format={(v) => `${Math.round(v * 100)}%`} label="Character opacity" />
        </Field>
        <Field label="Always on top" hint="Stay above other windows." inline>
          <Toggle checked={g.alwaysOnTop} onChange={(v) => set((d) => void (d.general.alwaysOnTop = v))} />
        </Field>
        <Field label="Click-through" hint="Clicks pass through the creature to whatever is behind it. Toggle back from the tray menu." inline>
          <Toggle checked={g.clickThrough} onChange={(v) => set((d) => void (d.general.clickThrough = v))} />
        </Field>
        <Field label="Desktop position" hint="Drag the creature to move it. Reset puts it in the bottom-right corner on next launch.">
          <button className="btn small" disabled={!g.position} onClick={() => set((d) => void (d.general.position = null))}>
            Reset position
          </button>
        </Field>
      </Section>

      <Section title="Keyboard shortcuts">
        <p className="dim section-note">Global shortcuts work from any app.</p>
        <Field label="Summon / hide Noli">
          <ShortcutInput value={g.shortcuts.toggleCharacter} onChange={(v) => set((d) => void (d.general.shortcuts.toggleCharacter = v))} />
        </Field>
        <Field label="Push to talk" hint="Hold to speak, release to send.">
          <ShortcutInput allowModifierOnly value={g.shortcuts.pushToTalk} onChange={(v) => set((d) => void (d.general.shortcuts.pushToTalk = v))} />
        </Field>
        <Field label="Open chat">
          <ShortcutInput value={g.shortcuts.openChat} onChange={(v) => set((d) => void (d.general.shortcuts.openChat = v))} />
        </Field>
      </Section>
    </>
  );
}
