import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/ui';
import { useDocumentAppearance, useSettings } from '../lib/useSettings';
import type { Settings } from '../lib/types';
import { providerById } from '../providers';
import { Onboarding } from './Onboarding';
import { General } from './sections/General';
import { HistorySection } from './sections/History';
import { AboutSection, AppearanceSection, PersonalitySection, PrivacySection } from './sections/Other';
import { Overview } from './sections/Overview';
import { ProviderSection } from './sections/Provider';
import { VoiceSection } from './sections/Voice';
import { ComputerSection } from './sections/Computer';

export const NAV = [
  { id: 'overview', label: 'Overview', icon: 'home', group: '', blurb: 'How Noli is doing and what needs attention.' },
  { id: 'general', label: 'General', icon: 'general', group: '', blurb: 'Startup, size on the desktop and keyboard shortcuts.' },
  { id: 'provider', label: 'AI Provider', icon: 'provider', group: 'Brain', blurb: 'Which AI answers for Noli, and which model it uses.' },
  { id: 'personality', label: 'Personality', icon: 'personality', group: 'Brain', blurb: 'Who Noli is and how he talks.' },
  { id: 'computer', label: 'Computer Control', icon: 'computer', group: 'Brain', blurb: 'Let Noli see your screen, open apps and use the mouse and keyboard.' },
  { id: 'voice', label: 'Voice', icon: 'voice', group: 'Senses', blurb: 'Microphone, speech recognition and the voice Noli speaks with.' },
  { id: 'appearance', label: 'Appearance', icon: 'appearance', group: 'Senses', blurb: 'How the creature moves and how this window looks.' },
  { id: 'history', label: 'History', icon: 'history', group: 'Memory', blurb: 'Past conversations. Pick one to read, continue or export it.' },
  { id: 'privacy', label: 'Privacy & Memory', icon: 'privacy', group: 'Memory', blurb: 'What Noli keeps, for how long, and what he remembers about you.' },
  { id: 'about', label: 'About', icon: 'about', group: 'end', blurb: '' },
] as const;
export type NavId = (typeof NAV)[number]['id'];
type Page = NavId | 'onboarding';
export type Update = (m: (d: Settings) => void) => Promise<string[]>;

export function SettingsApp() {
  const { settings, update: rawUpdate } = useSettings();
  useDocumentAppearance(settings);
  const [section, setSection] = useState<Page>(() => {
    // opened straight to a page (e.g. from an error bubble): index.html#provider
    const h = window.location.hash.slice(1);
    return NAV.some((n) => n.id === h) ? (h as NavId) : 'overview';
  });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const body = useRef<HTMLDivElement>(null);

  // every change saves immediately; show a small confirmation in the header
  const update = useCallback<Update>(
    async (m) => {
      setSaved('saving');
      clearTimeout(savedTimer.current);
      try {
        const w = await rawUpdate(m);
        setSaved('saved');
        if (w.length) setWarnings(w);
        savedTimer.current = setTimeout(() => setSaved('idle'), 1800);
        return w;
      } catch (e) {
        setSaved('error');
        setWarnings([`Could not save: ${String(e)}`]);
        return [];
      }
    },
    [rawUpdate],
  );

  useEffect(() => {
    const un = listen<string>('settings://section', ({ payload }) => {
      const known = NAV.some((n) => n.id === payload);
      setSection(known ? (payload as NavId) : 'overview');
    });
    return () => void un.then((f) => f());
  }, []);
  useEffect(() => {
    if (settings && !settings.general.onboardingComplete && !window.location.hash) setSection('onboarding');
    // only on first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!settings]);
  useEffect(() => body.current?.scrollTo(0, 0), [section]);

  if (!settings) return <div className="settings-loading"><span className="spinner" /></div>;

  if (section === 'onboarding') {
    return (
      <div className="settings-app onboarding-shell">
        <div className="titlebar" data-tauri-drag-region />
        <Onboarding s={settings} update={update} onDone={() => setSection('overview')} />
      </div>
    );
  }

  const page = NAV.find((n) => n.id === section)!;
  const active = providerById(settings.provider.active);
  let lastGroup = '';

  return (
    <div className="settings-app">
      <nav className="settings-nav">
        <div className="titlebar" data-tauri-drag-region />
        <button className="nav-brand" onClick={() => setSection('overview')}>
          <img src="/sprites/portrait.png" className="pixel nav-portrait" alt="" />
          <div className="grow">
            <div className="nav-name">NOLI</div>
            <div className="nav-sub">{active?.label ?? 'no brain'} · {settings.general.characterVisible ? 'on desktop' : 'hidden'}</div>
          </div>
        </button>
        <div className="nav-list">
          {NAV.map((n) => {
            const header = n.group && n.group !== 'end' && n.group !== lastGroup ? n.group : null;
            if (n.group !== 'end') lastGroup = n.group;
            return (
              <div key={n.id} className={n.group === 'end' ? 'nav-end' : undefined}>
                {header && <div className="nav-group">{header}</div>}
                <button className={`nav-item ${section === n.id ? 'active' : ''}`} onClick={() => setSection(n.id)}>
                  <Icon name={n.icon} />
                  <span>{n.label}</span>
                </button>
              </div>
            );
          })}
        </div>
      </nav>
      <div className="settings-body" ref={body}>
        <header className="page-head" data-tauri-drag-region>
          <div className="page-head-inner" data-tauri-drag-region>
            <div data-tauri-drag-region>
              <h1 className="page-title">{page.label}</h1>
              {page.blurb && <div className="page-blurb">{page.blurb}</div>}
            </div>
            <div className={`save-state ${saved}`} aria-live="polite">
              {saved === 'saving' && <span className="spinner" />}
              {saved === 'saved' && (
                <>
                  <Icon name="check" size={14} /> Saved
                </>
              )}
              {saved === 'error' && 'Not saved'}
            </div>
          </div>
        </header>
        <div className={`settings-content ${section === 'history' ? 'wide' : ''}`}>
          {warnings.length > 0 && (
            <div className="notice error page-warning">
              <div className="grow">
                {warnings.map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </div>
              <button className="btn ghost small" onClick={() => setWarnings([])}>
                Dismiss
              </button>
            </div>
          )}
          {section === 'overview' && <Overview s={settings} go={setSection} />}
          {section === 'general' && <General s={settings} update={update} />}
          {section === 'provider' && <ProviderSection s={settings} update={update} />}
          {section === 'voice' && <VoiceSection s={settings} update={update} />}
          {section === 'computer' && <ComputerSection s={settings} update={update} />}
          {section === 'appearance' && <AppearanceSection s={settings} update={update} />}
          {section === 'personality' && <PersonalitySection s={settings} update={update} />}
          {section === 'history' && <HistorySection />}
          {section === 'privacy' && <PrivacySection s={settings} update={update} />}
          {section === 'about' && <AboutSection onRerun={() => setSection('onboarding')} />}
        </div>
      </div>
    </div>
  );
}
