import { describe, expect, it } from 'vitest';
import { friendlyError, greeting, pokeLine } from './reactions';

describe('reactions', () => {
  it('escalates pokes', () => {
    expect(pokeLine(1)).toBeNull();
    expect(pokeLine(4)).toBeTypeOf('string');
    expect(pokeLine(9)).toBeTypeOf('string');
  });

  it('greets by time of day', () => {
    expect(greeting(8, () => 0)).toMatch(/morning/i);
    expect(greeting(2, () => 0)).toMatch(/late/i);
  });

  it('explains common errors and where to fix them', () => {
    expect(friendlyError('No Groq API key configured. Add one in Settings → AI Provider.').fix).toBe('provider');
    expect(friendlyError('OpenRouter error 429: Rate limit exceeded').text).toMatch(/rate-limiting/);
    expect(friendlyError('error sending request for url (https://openrouter.ai/api/v1/chat)').fix).toBeNull();
    expect(friendlyError('Could not open the microphone: no default input device').fix).toBe('voice');
    expect(friendlyError('something odd').text).toBe('something odd');
    expect(friendlyError('OpenRouter free-models-per-day limit: this account has used today').text).toMatch(/today's free/);
    expect(friendlyError('Free model busy upstream: Google AI Studio is rate-limiting this free model').text).toMatch(/overloaded/);
  });
});
