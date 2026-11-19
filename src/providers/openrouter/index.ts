import { api, errorText } from '../../lib/ipc';
import type { ModelInfo } from '../../lib/types';
import type { ProviderDescriptor } from '../types';

export const openrouterProvider: ProviderDescriptor = {
  id: 'openrouter',
  label: 'OpenRouter',
  tagline: 'Hundreds of hosted models through one API key. Pick any model you like.',
  async health() {
    try {
      const k = await api.openrouterKeyStatus();
      if (!k.configured) return { ready: false, summary: 'No API key', problem: 'Add an OpenRouter API key to use this provider.' };
      return { ready: true, summary: `Key ${k.hint}`, problem: null };
    } catch (e) {
      return { ready: false, summary: 'Credential store unavailable', problem: errorText(e) };
    }
  },
};

export function formatPrice(m: ModelInfo): string {
  if (m.promptPrice == null) return '';
  if (m.promptPrice === 0 && (m.completionPrice ?? 0) === 0) return 'free';
  const f = (n: number) => (n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 1 : 0));
  return `$${f(m.promptPrice)} / $${f(m.completionPrice ?? 0)} per M`;
}

/** Matches every search term against id and name. */
export function filterModels(models: ModelInfo[], q: string): ModelInfo[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return models;
  return models.filter((m) => {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
