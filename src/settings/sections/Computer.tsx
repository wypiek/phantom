import { useEffect, useState } from 'react';
import { Field, Section, Toggle } from '../../components/ui';
import { api } from '../../lib/ipc';
import type { Settings } from '../../lib/types';

type Props = { s: Settings; update: (m: (d: Settings) => void) => Promise<string[]> };

const MODES = [
  { id: 'ask', label: 'Ask me first', description: 'Noli can look at your screen. Opening apps, clicking, typing and key presses show Allow / Always / Deny first. Recommended.' },
  { id: 'trusted', label: 'Trusted', description: 'Apps, mouse and keyboard run without asking. Shell commands still always ask.' },
  { id: 'off', label: 'Off', description: "No screen, apps, mouse, keyboard or commands. Noli can only talk." },
] as const;

/** Settings for letting Noli see the screen and control apps, mouse and keyboard. */
export function ComputerSection({ s, update }: Props) {
  const c = s.computer;
  const [perms, setPerms] = useState<{ input: boolean; screen: boolean } | null>(null);
  const check = () => void api.computerPermissions().then(setPerms).catch(() => setPerms(null));
  useEffect(() => {
    check();
    const t = setInterval(check, 3000); // pick up changes made in System Settings
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <Section title="Computer control">
        <p className="dim section-note">Ask things like “open Spotify”, “what’s on my screen?” or “search YouTube for lofi in Safari”. Noli takes a screenshot, decides, and acts step by step.</p>
        <Field label="Mode">
          <div className="radio-list">
            {MODES.map((m) => (
              <label key={m.id} className={`radio ${c.mode === m.id ? 'selected' : ''}`}>
                <input type="radio" name="control-mode" checked={c.mode === m.id} onChange={() => void update((d) => void (d.computer.mode = m.id))} />
                <div>
                  <div>{m.label}</div>
                  <div className="faint small-text">{m.description}</div>
                </div>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Send screenshots to the AI" hint="Needed for Noli to actually see the screen and click things. Use a vision model (e.g. Groq Llama 4 Scout, or a Gemini/Claude/GPT model on OpenRouter). Screenshots go to your AI provider and are not saved." inline>
          <Toggle checked={c.sendScreenshots} onChange={(v) => void update((d) => void (d.computer.sendScreenshots = v))} />
        </Field>
        <Field label="Steps per request" hint="How many look-and-act rounds Noli may take for one request.">
          <select className="select" value={c.maxSteps} onChange={(e) => void update((d) => void (d.computer.maxSteps = Number(e.target.value)))}>
            {[3, 5, 8, 12, 16].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="macOS permissions">
        <Field label="Screen Recording" hint="Lets Noli see other apps' windows. Without it, screenshots only show the wallpaper." inline>
          <PermissionState ok={perms?.screen} onFix={() => void api.computerOpenPermission('screen')} />
        </Field>
        <Field label="Accessibility" hint="Lets Noli move the mouse, click and type." inline>
          <PermissionState ok={perms?.input} onFix={() => void api.computerOpenPermission('accessibility')} />
        </Field>
        <p className="faint small-text section-note">
          “Allow…” adds PHANTOM to the list in System Settings; switch it on there and this page updates within a few seconds. If PHANTOM isn't listed, click <b>+</b> under the list and pick PHANTOM from Applications.
        </p>
        {perms && (!perms.screen || !perms.input) && (
          <div className="row section-note">
            <span className="faint small-text grow">Switched it on but it still says off? macOS sometimes only applies it after a restart.</span>
            <button className="btn small" onClick={() => void api.restart()}>
              Restart PHANTOM
            </button>
          </div>
        )}
      </Section>
    </>
  );
}

function PermissionState({ ok, onFix }: { ok: boolean | undefined; onFix: () => void }) {
  if (ok === undefined) return <span className="spinner" />;
  return ok ? (
    <span className="label-pill ok">allowed</span>
  ) : (
    <button className="btn small" onClick={onFix}>
      Allow…
    </button>
  );
}
