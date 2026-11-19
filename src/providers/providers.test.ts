import { describe, expect, it } from 'vitest';
import { filterModels, formatPrice } from './openrouter';
import type { ModelInfo } from '../lib/types';

const m = (id: string, name: string, p: number | null = 3, c: number | null = 15): ModelInfo => ({ id, name, contextLength: null, promptPrice: p, completionPrice: c, description: null });

describe('openrouter helpers', () => {
  it('filters by all terms across id and name', () => {
    const list = [m('anthropic/claude-sonnet-5.5', 'Claude Sonnet'), m('openai/gpt-x', 'GPT X'), m('meta/llama', 'Llama')];
    expect(filterModels(list, 'claude son').map((x) => x.id)).toEqual(['anthropic/claude-sonnet-5.5']);
    expect(filterModels(list, '').length).toBe(3);
  });
  it('formats prices', () => {
    expect(formatPrice(m('a', 'a', 0, 0))).toBe('free');
    expect(formatPrice(m('a', 'a', 3, 15))).toBe('$3.0 / $15 per M');
    expect(formatPrice(m('a', 'a', null, null))).toBe('');
  });
});
