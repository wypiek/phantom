import { api, errorText } from '../../lib/ipc';
import type { ProviderDescriptor } from '../types';

export const claudeCodeProvider: ProviderDescriptor = {
  id: 'claude-code',
  label: 'Claude Code',
  tagline: 'Your installed Claude Code agent. It can read and change files in a workspace you choose, with your approval.',
  async health() {
    try {
      const s = await api.claudeStatus();
      if (!s.installed) return { ready: false, summary: 'Not installed', problem: s.error };
      if (!s.loggedIn) return { ready: false, summary: `Installed${s.version ? ` · ${s.version}` : ''}`, problem: s.error };
      return { ready: true, summary: `Signed in${s.subscription ? ` (${s.subscription})` : ''}${s.version ? ` · ${s.version}` : ''}`, problem: null };
    } catch (e) {
      return { ready: false, summary: 'Unavailable', problem: errorText(e) };
    }
  },
};

export const PERMISSION_MODES = [
  { id: 'ask', label: 'Ask me first', description: 'Reads are allowed; edits, commands and web access show an approval dialog. Recommended.' },
  { id: 'accept-edits', label: 'Auto-accept file edits', description: 'File edits inside the workspace are applied automatically; commands still ask.' },
  { id: 'read-only', label: 'Read-only', description: 'Plan mode: the agent can look but never change anything.' },
  { id: 'chat-only', label: 'Chat only', description: 'No tools at all, just conversation.' },
] as const;
