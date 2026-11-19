import { useState } from 'react';
import { Toggle, useAsync } from '../components/ui';
import { api } from '../lib/ipc';
import type { Settings } from '../lib/types';
import { PROVIDERS } from '../providers';
import { ClaudeCodeSettings, GroqSettings, OpenRouterSettings } from './sections/Provider';
import { MicTest, PresetPicker, preview, WhisperModels } from './sections/Voice';

type Props = { s: Settings; update: (m: (d: Settings) => void) => Promise<string[]>; onDone: () => void };

const STEPS = ['Awakening', 'Brain', 'Ears', 'Voice', 'Ready'];

/** First-launch setup wizard: checks dependencies and walks through configuration. */
export function Onboarding({ s, update, onDone }: Props) {
  const [step, setStep] = useState(0);
  const claude = useAsync(() => api.claudeStatus(), []);
  const key = useAsync(() => api.openrouterKeyStatus(), [step]);
  const models = useAsync(() => api.voiceModels(), [step]);
  const providerReady = s.provider.active === 'claude-code' ? !!claude.data?.loggedIn : !!key.data?.configured;
  const sttReady = !!models.data?.find((m) => m.name === s.voice.whisperModel)?.downloaded;

  const finish = async () => {
    await update((d) => void (d.general.onboardingComplete = true));
    onDone();
    void api.openWindow('chat');
  };

  return (
    <div className="onboarding">
      <div className="steps">
        {STEPS.map((t, i) => (
          <button key={t} className={`step ${i === step ? 'current' : ''} ${i < step ? 'done' : ''}`} onClick={() => setStep(i)}>
            <span className="step-n">{i + 1}</span>
            {t}
          </button>
        ))}
      </div>

      <div className="onboarding-body">
        {step === 0 && (
          <div className="welcome">
            <img src="/sprites/portrait.png" className="pixel welcome-portrait" alt="" />
            <div>
              <h1 className="welcome-title">Something moved in your computer.</h1>
              <p className="dim">
                Noli is an animated digital companion that lives on your desktop. He talks with you through an AI brain, can inspect your screen, open apps, help you with tasks, and communicate with you.
              </p>
              <p className="dim">Setup takes about two minutes. Everything can be changed later in Settings.</p>
              <div className="checklist">
                <Check ok={!!claude.data?.installed} label={claude.data?.installed ? `Claude Code found (${claude.data.version ?? 'unknown version'})` : 'Claude Code not found (optional — OpenRouter works too)'} loading={claude.loading} />
                <Check ok={!!key.data?.configured} label={key.data?.configured ? 'OpenRouter key saved' : 'No OpenRouter key yet (optional)'} />
                <Check ok={sttReady} label={sttReady ? 'Speech model ready' : 'Speech model not downloaded yet'} loading={models.loading} />
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2>Choose Noli's brain</h2>
            <div className="choice-grid">
              {PROVIDERS.map((p) => (
                <button key={p.id} className={`choice ${s.provider.active === p.id ? 'selected' : ''}`} onClick={() => void update((d) => void (d.provider.active = p.id))}>
                  <div className="choice-title">{p.label}</div>
                  <div className="choice-desc">{p.tagline}</div>
                </button>
              ))}
            </div>
            {s.provider.active === 'claude-code' ? <ClaudeCodeSettings s={s} update={update} compact /> : s.provider.active === 'groq' ? <GroqSettings s={s} update={update} compact /> : <OpenRouterSettings s={s} update={update} compact />}
          </div>
        )}

        {step === 2 && (
          <div>
            <h2>Let it hear you</h2>
            <p className="dim">Speech recognition runs locally with Whisper. Download a model (one time), then test your microphone. Your OS may ask for microphone permission.</p>
            <div className="row" style={{ margin: '8px 0 14px' }}>
              <span>Voice input</span>
              <Toggle checked={s.voice.enabled} onChange={(v) => void update((d) => void (d.voice.enabled = v))} />
            </div>
            {s.voice.enabled && (
              <>
                <WhisperModels s={s} update={update} />
                <div style={{ marginTop: 14 }}>{sttReady ? <MicTest /> : <div className="faint">Download a model to test the microphone.</div>}</div>
                <p className="dim small-text" style={{ marginTop: 14 }}>
                  Push to talk: hold <span className="kbd">{s.general.shortcuts.pushToTalk.replace('CommandOrControl', '⌘/Ctrl')}</span> anywhere, speak, release.
                </p>
              </>
            )}
          </div>
        )}

        {step === 3 && (
          <div>
            <h2>Give it a voice</h2>
            <p className="dim">Pick how Noli sounds. You can fine-tune every effect later.</p>
            <div className="row" style={{ margin: '8px 0 14px' }}>
              <span>Speak replies aloud</span>
              <Toggle checked={s.tts.enabled} onChange={(v) => void update((d) => void (d.tts.enabled = v))} />
            </div>
            <PresetPicker s={s} update={update} />
            <button className="btn" style={{ marginTop: 12 }} onClick={() => preview('Hello. I have been waiting for you.')}>
              ▶ Hear it
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="welcome">
            <img src="/sprites/portrait.png" className="pixel welcome-portrait" alt="" />
            <div>
              <h1 className="welcome-title">It is awake.</h1>
              <div className="checklist">
                <Check ok={providerReady} label={providerReady ? `Brain: ${s.provider.active === 'claude-code' ? 'Claude Code' : 'OpenRouter'}` : 'The chosen brain is not configured yet'} />
                <Check ok={sttReady || !s.voice.enabled} label={!s.voice.enabled ? 'Voice input off' : sttReady ? 'Ears: Whisper ready' : 'Speech model missing — voice input will not work yet'} />
                <Check ok label={s.tts.enabled ? `Voice: ${s.tts.preset.toUpperCase()}` : 'Voice output off'} />
              </div>
              <div className="row" style={{ margin: '16px 0' }}>
                <span>Launch at startup</span>
                <Toggle checked={s.general.launchAtStartup} onChange={(v) => void update((d) => void (d.general.launchAtStartup = v))} />
              </div>
              <ul className="dim tips">
                <li>Drag the creature anywhere. Double-click it to open the chat, right-click for options.</li>
                <li>
                  <span className="kbd">{s.general.shortcuts.toggleCharacter.replace('CommandOrControl', '⌘/Ctrl')}</span> summons or hides it.
                </li>
                <li>It lives in the menu bar / system tray when hidden.</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="onboarding-foot">
        <button className="btn ghost" onClick={() => void finish()}>
          Skip setup
        </button>
        <div className="grow" />
        {step > 0 && (
          <button className="btn" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < STEPS.length - 1 ? (
          <button className="btn primary" onClick={() => setStep(step + 1)}>
            Continue
          </button>
        ) : (
          <button className="btn primary" onClick={() => void finish()}>
            Open the chat
          </button>
        )}
      </div>
    </div>
  );
}

function Check({ ok, label, loading }: { ok: boolean; label: string; loading?: boolean }) {
  return (
    <div className={`check ${ok ? 'ok' : ''}`}>
      {loading ? <span className="spinner" /> : <span className="check-mark">{ok ? '✓' : '·'}</span>}
      <span>{label}</span>
    </div>
  );
}
