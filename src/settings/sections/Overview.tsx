import { emitTo } from '@tauri-apps/api/event';
import type { ReactNode } from 'react';
import { Icon, Status, useAsync } from '../../components/ui';
import { api } from '../../lib/ipc';
import { prettyShortcut } from '../../lib/shortcuts';
import type { Settings } from '../../lib/types';
import { providerById } from '../../providers';
import type { NavId } from '../SettingsApp';

type Props = { s: Settings; go: (id: NavId) => void };

function modelOf(s: Settings): string {
  const p = s.provider;
  if (p.active === 'openrouter') return p.openrouter.model;
  if (p.active === 'groq') return p.groq.model;
  return p.claudeCode.model || 'Claude Code default';
}

/** Landing page: status of each part of Noli, with one-click fixes. */
export function Overview({ s, go }: Props) {
  const provider = providerById(s.provider.active);
  const health = useAsync(() => provider?.health() ?? Promise.resolve(null), [s.provider.active]);
  const models = useAsync(() => api.voiceModels(), []);
  const perms = useAsync(() => api.computerPermissions(), []);
  const mems = useAsync(() => api.memories(), []);
  const convs = useAsync(() => api.conversations(), []);

  const sttReady = models.data?.find((m) => m.name === s.voice.whisperModel)?.downloaded;
  const ptt = prettyShortcut(s.general.shortcuts.pushToTalk);
  const control = s.computer.mode;
  const permsOk = perms.data ? perms.data.screen && perms.data.input : undefined;

  const problems: { text: string; fix: NavId; action: string }[] = [];
  if (health.data && !health.data.ready) problems.push({ text: health.data.problem ?? `${provider?.label} is not ready.`, fix: 'provider', action: 'Set up' });
  if (s.voice.enabled && models.data && !sttReady) problems.push({ text: `The speech model “${s.voice.whisperModel}” is not downloaded, so Noli can't hear you yet.`, fix: 'voice', action: 'Download' });
  if (control !== 'off' && perms.data && !permsOk) problems.push({ text: `macOS hasn't allowed ${!perms.data.screen && !perms.data.input ? 'Screen Recording or Accessibility' : !perms.data.screen ? 'Screen Recording' : 'Accessibility'} yet, so computer control is limited.`, fix: 'computer', action: 'Fix' });

  return (
    <>
      <div className="hero">
        <img src="/sprites/portrait.png" className="pixel hero-portrait" alt="" />
        <div className="grow">
          <div className="hero-title">{problems.length ? 'Noli needs a hand.' : 'Noli is ready.'}</div>
          <div className="dim">
            {s.general.characterVisible ? 'He is on your desktop.' : 'He is hiding.'} {ptt ? <>Hold <span className="kbd">{ptt}</span> to talk, or click the bubble next to him to type.</> : 'Click the bubble next to him to type.'}
          </div>
          <div className="row hero-actions">
            <button className="btn primary" onClick={() => void emitTo('companion', 'companion://command', 'chatbox-open').then(() => api.companionSetVisible(true))}>
              <Icon name="chat" size={14} /> Open chatbox
            </button>
            <button className="btn" onClick={() => void api.companionToggle()}>
              {s.general.characterVisible ? 'Hide Noli' : 'Show Noli'}
            </button>
            <button className="btn ghost" onClick={() => void emitTo('companion', 'companion://command', 'poke')}>
              Poke him
            </button>
          </div>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="todo-list">
          {problems.map((p) => (
            <div key={p.text} className="todo">
              <span className="todo-mark">!</span>
              <div className="grow">{p.text}</div>
              <button className="btn small primary" onClick={() => go(p.fix)}>
                {p.action}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card-grid">
        <Card
          icon="provider"
          title="Brain"
          onClick={() => go('provider')}
          status={health.loading ? <span className="spinner" /> : health.data?.ready ? <Status tone="ok">ready</Status> : <Status tone="bad">not ready</Status>}
        >
          <div className="card-big">{provider?.label ?? 'None'}</div>
          <div className="mono faint small-text ellipsis">{modelOf(s)}</div>
        </Card>
        <Card
          icon="voice"
          title="Voice"
          onClick={() => go('voice')}
          status={!s.voice.enabled ? <Status tone="idle">mic off</Status> : sttReady === undefined ? <span className="spinner" /> : sttReady ? <Status tone="ok">hearing</Status> : <Status tone="warn">no model</Status>}
        >
          <div className="card-big">{s.voice.mode === 'continuous' ? 'Always listening' : `Hold ${ptt || '—'}`}</div>
          <div className="faint small-text">
            {s.tts.enabled ? `Speaks with the ${s.tts.preset.toUpperCase()} voice` : 'Speech output is off'}
          </div>
        </Card>
        <Card
          icon="computer"
          title="Computer control"
          onClick={() => go('computer')}
          status={control === 'off' ? <Status tone="idle">off</Status> : permsOk === undefined ? <span className="spinner" /> : permsOk ? <Status tone="ok">allowed</Status> : <Status tone="warn">needs access</Status>}
        >
          <div className="card-big">{control === 'off' ? 'Talk only' : control === 'ask' ? 'Asks before acting' : 'Trusted'}</div>
          <div className="faint small-text">{s.computer.sendScreenshots ? 'Can look at your screen' : 'Screenshots are not sent'}</div>
        </Card>
        <Card icon="history" title="Memory" onClick={() => go('history')} status={<Status tone={s.privacy.memoryEnabled ? 'ok' : 'idle'}>{s.privacy.memoryEnabled ? 'remembering' : 'forgetful'}</Status>}>
          <div className="card-big">
            {convs.data?.length ?? '…'} conversation{convs.data?.length === 1 ? '' : 's'}
          </div>
          <div className="faint small-text">
            {mems.data?.length ?? 0} thing{mems.data?.length === 1 ? '' : 's'} remembered about you
          </div>
        </Card>
      </div>
    </>
  );
}

function Card({ icon, title, status, children, onClick }: { icon: string; title: string; status: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button className="card" onClick={onClick}>
      <div className="card-head">
        <span className="card-icon">
          <Icon name={icon} />
        </span>
        <span className="card-title">{title}</span>
        <span className="grow" />
        {status}
      </div>
      <div className="card-body">{children}</div>
      <span className="card-go">
        <Icon name="arrow" size={14} />
      </span>
    </button>
  );
}
