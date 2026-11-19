import type { ProviderId } from '../lib/types';

export interface ProviderHealth {
  ready: boolean;
  /** One-line human status, e.g. "Signed in · v2.1" */
  summary: string;
  problem: string | null;
}

/**
 * Frontend descriptor for an AI backend. The actual integration (network,
 * process management, secrets) lives in `src-tauri/src/providers/<id>.rs`;
 * descriptors only expose status and configuration helpers to the UI.
 */
export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  tagline: string;
  health(): Promise<ProviderHealth>;
}
