import { describe, expect, it } from 'vitest';
import { parseNameAnswer, sameName, strangerMemory } from './intro';

const name = (s: string) => {
  const r = parseNameAnswer(s);
  return r.kind === 'name' ? r.name : r.kind;
};

describe('parseNameAnswer', () => {
  it('understands the usual ways of saying a name', () => {
    expect(name('Ada')).toBe('Ada');
    expect(name('ada.')).toBe('Ada');
    expect(name('My name is Ada Lovelace.')).toBe('Ada Lovelace');
    expect(name("I'm Bob")).toBe('Bob');
    expect(name('Hi Noli, I’m Jean-Luc, nice to meet you')).toBe('Jean-Luc');
    expect(name('call me Al')).toBe('Al');
    expect(name("It's Sam")).toBe('Sam');
    expect(name('This is Priya speaking')).toBe('Priya');
    expect(name('Marek here')).toBe('Marek');
    expect(name('Hello. My name is MARIA')).toBe('Maria');
    expect(name('They call me McKenzie')).toBe('McKenzie');
    expect(name('the name’s Bond. James Bond.')).toBe('Bond');
  });

  it('does not invent names from non-answers', () => {
    expect(name("I'm fine, thanks")).toBe('none');
    expect(name("It's nice to meet you")).toBe('none');
    expect(name('what do you mean')).toBe('none');
    expect(name("I'm not sure")).toBe('none');
    expect(name('')).toBe('none');
  });

  it('recognises refusals and "it\'s me"', () => {
    expect(name('skip')).toBe('refuse');
    expect(name("I'd rather not say")).toBe('refuse');
    expect(name('No.')).toBe('refuse');
    expect(name("it's me")).toBe('self');
    expect(name("It's just me.")).toBe('self');
    expect(name("It's me, Ada")).toBe('Ada');
    expect(name("that's my friend Bob")).toBe('Bob');
    expect(name('This is my sister, Ola')).toBe('Ola');
  });
});

describe('helpers', () => {
  it('compares names loosely', () => {
    expect(sameName('ada ', 'Ada')).toBe(true);
    expect(sameName('Ada', null)).toBe(false);
  });
  it('mentions the main user in a stranger memory', () => {
    expect(strangerMemory('Bob', 'Ada')).toContain('not Ada');
  });
});
