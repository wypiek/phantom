import { api, errorText } from '../../lib/ipc';
import type { ProviderDescriptor } from '../types';

export const groqProvider: ProviderDescriptor = {
  id: 'groq',
  label: 'Groq',
  tagline: 'Very fast open models (Llama, Qwen, Kimi) on a free API key. The quickest replies.',
  async health() {
    try {
      const k = await api.groqKeyStatus();
      if (!k.configured) return { ready: false, summary: 'No API key', problem: 'Add a Groq API key to use this provider.' };
      return { ready: true, summary: `Key ${k.hint}`, problem: null };
    } catch (e) {
      return { ready: false, summary: 'Credential store unavailable', problem: errorText(e) };
    }
  },
};
