import { getCurrentWindow } from '@tauri-apps/api/window';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import './styles/companion.css';
import './styles/chat.css';
import './styles/settings.css';
import { ChatApp } from './chat/ChatApp';
import { Companion } from './companion/Companion';
import { SettingsApp } from './settings/SettingsApp';

// One bundle, three windows: the label decides which UI this webview shows.
const label = getCurrentWindow().label;
const App = label === 'companion' ? Companion : label === 'settings' ? SettingsApp : ChatApp;

// macOS settings window draws under the traffic lights; others have a normal title bar.
document.documentElement.classList.add(/Mac/.test(navigator.userAgent) ? 'platform-mac' : 'platform-other');

// Disable the browser context menu outside text fields (native app feel).
window.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest('input, textarea, .selectable')) e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  label === 'companion' ? (
    <App />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
);
