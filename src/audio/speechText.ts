// Turns streamed markdown into speakable phrases, sentence by sentence.

const CODE_PLACEHOLDER = ' I put some code in the chat. ';

/**
 * Removes things that should never be read aloud. In `partial` mode, trailing
 * unfinished constructs (an open code fence, an open <remember> tag, a link
 * still being typed) are cut so the speakable prefix stays stable while text streams.
 */
export function stripForSpeech(raw: string, partial = false): string {
  let t = raw;
  if (partial) {
    const fences = t.match(/```/g)?.length ?? 0;
    if (fences % 2 === 1) t = t.slice(0, t.lastIndexOf('```')) + CODE_PLACEHOLDER;
    const openRemember = t.lastIndexOf('<remember>');
    if (openRemember >= 0 && t.indexOf('</remember>', openRemember) < 0) t = t.slice(0, openRemember);
    const openTag = t.lastIndexOf('<');
    if (openTag >= 0 && t.indexOf('>', openTag) < 0 && t.length - openTag < 12) t = t.slice(0, openTag);
    const openLink = t.lastIndexOf('[');
    if (openLink >= 0 && !/\]\([^)]*\)/.test(t.slice(openLink))) {
      const close = t.indexOf(']', openLink);
      if (close < 0 || t[close + 1] === '(') t = t.slice(0, openLink);
    }
  }
  t = t
    // roleplay narration is never read aloud: "*the screen flickers*", lone "(sighs)"
    .replace(/^\s*[*_][^*_\n]+[*_]\s*$/gm, '')
    .replace(/[ \t]*(?<!\*)\*(?!\*)[^*\n]{1,60}\*(?!\*)/g, '')
    .replace(/^\s*\([^)\n]{1,40}\)\s*$/gm, '')
    .replace(/<action[\s\S]*?(\/>|<\/action>)/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<remember>[\s\S]*?<\/remember>/g, '')
    .replace(/```[\s\S]*?```/g, CODE_PLACEHOLDER)
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|?[-:\s|]{3,}\|?\s*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/[*_~]{2,}/g, '');
  // collapse repeated placeholders
  while (t.includes(CODE_PLACEHOLDER + CODE_PLACEHOLDER)) t = t.replace(CODE_PLACEHOLDER + CODE_PLACEHOLDER, CODE_PLACEHOLDER);
  return t;
}

/** True if the phrase contains anything worth sending to a speech engine. */
export function isSpeakable(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/**
 * Incrementally splits streamed text into sentences/phrases for TTS so the
 * first sentence can be spoken while the rest is still being generated.
 */
export class SentenceChunker {
  private raw = '';
  private emitted = 0;
  private first = true;
  constructor(private maxLen = 220) {}

  push(delta: string): string[] {
    this.raw += delta;
    return this.take(false);
  }

  /** Call when the message is complete. */
  flush(): string[] {
    return this.take(true);
  }

  private take(final: boolean): string[] {
    const speak = stripForSpeech(this.raw, !final);
    const out: string[] = [];
    let rest = speak.slice(this.emitted);
    for (;;) {
      const m = rest.match(/^[\s\S]*?(?:[.!?…]+["'”’)\]]*(?=\s)|\n\s*\n|\n(?=\s*\S))/);
      let cut = m ? m[0].length : -1;
      // Speak the very first phrase as soon as a clause is complete (lower latency).
      if (cut < 0 && this.first && !final) {
        const re = /[,;:—–]\s/g;
        for (let mm = re.exec(rest); mm; mm = re.exec(rest)) {
          if (mm.index >= 24) {
            cut = mm.index + 1;
            break;
          }
        }
      }
      if (cut < 0 && rest.length > this.maxLen) {
        const window = rest.slice(0, this.maxLen);
        const soft = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' — '));
        cut = soft > 40 ? soft + 1 : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : this.maxLen;
      }
      if (cut < 0) break;
      const piece = rest.slice(0, cut);
      this.emitted += cut;
      rest = rest.slice(cut);
      const clean = piece.replace(/\s+/g, ' ').trim();
      if (isSpeakable(clean)) {
        out.push(clean);
        this.first = false;
      }
    }
    if (final) {
      const clean = rest.replace(/\s+/g, ' ').trim();
      this.emitted += rest.length;
      if (isSpeakable(clean)) out.push(clean);
    }
    return out;
  }
}
