import { describe, expect, it } from 'vitest';
import { SentenceChunker, stripForSpeech } from './speechText';

describe('stripForSpeech', () => {
  it('removes markdown, links, memory tags and code', () => {
    const s = stripForSpeech('# Title\n**Bold** and `code` see [docs](http://x.y).\n```js\nlet a=1\n```\n<remember>secret</remember>');
    expect(s).toContain('Bold and code see docs.');
    expect(s).toContain('I put some code in the chat.');
    expect(s).not.toContain('secret');
    expect(s).not.toContain('#');
    expect(s).not.toContain('let a');
  });

  it('cuts unfinished constructs in partial mode', () => {
    expect(stripForSpeech('Look here ```py\nprint(1)', true)).not.toContain('print');
    expect(stripForSpeech('Fine. <remember>half', true)).toBe('Fine. ');
    expect(stripForSpeech('See [the do', true)).toBe('See ');
  });

  it('replaces bare urls', () => {
    expect(stripForSpeech('Go to https://example.com/a?b=c now')).toBe('Go to a link now');
  });
});

describe('roleplay', () => {
  it('is never read aloud', () => {
    expect(stripForSpeech('*the screen dims, then flickers back*\n\nAh. Budget cuts.').trim()).toBe('Ah. Budget cuts.');
    expect(stripForSpeech('Hello *waves* there.')).toBe('Hello there.');
    expect(stripForSpeech('Fine. <action name="click" x="1" y="2" /> Done.')).toBe('Fine.  Done.');
  });
});

describe('SentenceChunker', () => {
  it('starts speaking at the first clause', () => {
    const c = new SentenceChunker();
    expect(c.push('Right, opening Safari for you now, then')).toEqual(['Right, opening Safari for you now,']);
  });

  it('emits complete sentences as text streams in', () => {
    const c = new SentenceChunker();
    expect(c.push('Hello there')).toEqual([]);
    expect(c.push('. I am inside')).toEqual(['Hello there.']);
    expect(c.push(' your machine! What')).toEqual(['I am inside your machine!']);
    expect(c.flush()).toEqual(['What']);
  });

  it('never reads code blocks even when split across deltas', () => {
    const c = new SentenceChunker();
    const out = [...c.push('Here you go:\n\n```'), ...c.push('ts\nconst x = 1;\n'), ...c.push('```\n\nDone. '), ...c.flush()];
    expect(out.join(' ')).not.toContain('const');
    expect(out.join(' ')).toContain('Done.');
    expect(out.filter((s) => s.includes('code')).length).toBe(1);
  });

  it('splits very long sentences at soft boundaries', () => {
    const c = new SentenceChunker(80);
    const long = 'word, '.repeat(40);
    const out = [...c.push(long), ...c.flush()];
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((s) => s.length <= 82)).toBe(true);
  });

  it('skips punctuation-only fragments and memory tags', () => {
    const c = new SentenceChunker();
    const out = [...c.push('Noted. <remember>likes tea</remember>\n\n'), ...c.flush()];
    expect(out).toEqual(['Noted.']);
  });
});
