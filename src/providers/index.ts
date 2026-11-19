import type { ProviderId } from '../lib/types';
import { claudeCodeProvider } from './claude-code';
import { groqProvider } from './groq';
import { openrouterProvider } from './openrouter';
import type { ProviderDescriptor } from './types';

/** Registry of available AI providers. Add new providers here and in the Rust `providers` module. */
export const PROVIDERS: ProviderDescriptor[] = [claudeCodeProvider, openrouterProvider, groqProvider];

export function providerById(id: ProviderId | string | null | undefined): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export type { ProviderDescriptor, ProviderHealth } from './types';
