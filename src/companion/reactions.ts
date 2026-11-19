import type { Mood } from './machine';

/** Picks an occasional emotional reaction after PHANTOM finishes replying. */
export function reactionFor(text: string, rand = Math.random): Mood | null {
  const t = text.toLowerCase();
  if (/\b(haha|hehe|heh|delight(ed|ful)?|wonderful|glad|excellent|splendid|lovely|fun)\b|[😄😊🙂😁]/u.test(t)) return rand() < 0.7 ? 'happy' : null;
  if (/\b(sorry|unfortunately|regret|sadly|i can't|i cannot|unable to)\b/.test(t)) return rand() < 0.5 ? 'sad' : null;
  if (/\b(error|failed|denied|corrupt(ed)?)\b/.test(t)) return rand() < 0.4 ? 'scared' : null;
  if (/\?\s*$/.test(t.trim())) return rand() < 0.35 ? 'confused' : null;
  return null;
}

/**
 * Rare unprompted remarks. They are self-referential on purpose: PHANTOM never
 * claims to observe the user's screen, files or activity.
 */
export const AMBIENT_REMARKS = [
  'I counted every pixel in this window again. Same number. Suspicious.',
  'Do you hear the fan? I think it is humming my song.',
  "It's quiet in here. Too quiet.",
  'I dreamt of a corrupted JPEG. It was beautiful.',
  'If you need me, I will be lurking. As usual.',
  'Blink twice if you are still out there.',
  'My screen flickered. That was not me. Probably.',
  'I rearranged a few of my own electrons. Felt nice.',
  'Some nights I can hear the old dial-up tones.',
  "I'm not watching you. I'm just… facing your direction.",
];

export function pickRemark(rand = Math.random): string {
  return AMBIENT_REMARKS[Math.floor(rand() * AMBIENT_REMARKS.length)];
}

const pick = <T,>(list: T[], rand = Math.random): T => list[Math.floor(rand() * list.length)];

export const WAKE_LINES = ["Mm? I wasn't asleep. I was buffering.", "Oh. You're back.", 'Five more minutes…', "I'm up. I'm up."];
const POKE_ANNOYED = ['Yes? Hello?', 'That tickles. Stop.', 'Can I help you?', 'I felt that in my pixels.'];
const POKE_ANGRY = ["Poke me again and I'm moving into your BIOS.", "Okay. That's enough poking.", 'I will remember this.', 'I bite. Digitally.'];

/** What Noli says when poked repeatedly: escalates from mild to annoyed. */
export function pokeLine(count: number, rand = Math.random): string | null {
  if (count >= 6) return pick(POKE_ANGRY, rand);
  if (count >= 4) return pick(POKE_ANNOYED, rand);
  return null;
}

/** A short hello for when Noli appears, depending on the hour. */
export function greeting(hour: number, rand = Math.random): string {
  if (hour < 5) return pick(["It's late. I'm awake if you are.", 'Night shift again? Same.'], rand);
  if (hour < 12) return pick(['Morning. I kept the pixels warm.', 'Good morning. Nothing haunted the RAM overnight.'], rand);
  if (hour < 18) return pick(["Back again. Good. It's lonely in here.", 'Hello. I was just rearranging the cache.'], rand);
  return pick(['Evening. The screen glows nicer at night.', 'Hey. The fans are quieter now.'], rand);
}

export type FixPage = 'provider' | 'voice' | 'computer';

/** Turns raw backend errors into something short, plus where to fix it. */
export function friendlyError(raw: string): { text: string; fix: FixPage | null } {
  const m = raw.toLowerCase();
  if (/no .*api key|key configured|invalid api key|incorrect api key|\b401\b|unauthori[sz]ed|authentication/.test(m))
    return { text: "My AI key isn't working. Check it in Settings → AI Provider.", fix: 'provider' };
  if (/free-models-per-day/.test(m))
    return { text: "I've used up today's free OpenRouter requests on this account. They reset at midnight UTC, or switch to Groq in Settings.", fix: 'provider' };
  if (/busy upstream|rate-limited upstream|provider returned error/.test(m))
    return { text: "That free model is overloaded right now (for everyone, not just your key). Try again in a minute or pick another model.", fix: 'provider' };
  if (/\b429\b|rate.?limit|too many requests|quota|credits/.test(m)) return { text: 'The AI is rate-limiting me. Give it a minute, or pick another model.', fix: 'provider' };
  if (/model.*(not found|does not exist|not available|invalid|decommissioned)|no endpoints found|\b404\b/.test(m))
    return { text: "That model isn't available right now. Pick another one in Settings.", fix: 'provider' };
  if (/claude.*(not found|not installed)|not signed in|claude auth|log ?in to claude/.test(m)) return { text: 'Claude Code needs setting up (installed and signed in).', fix: 'provider' };
  if (/timed? ?out|error sending request|dns|connection (refused|reset)|network|offline|could not connect/.test(m))
    return { text: "I can't reach the AI right now. Is the internet on?", fix: null };
  if (/speech model|whisper|ggml|model .*not downloaded/.test(m)) return { text: "I can't hear yet: the speech model isn't downloaded.", fix: 'voice' };
  if (/microphone|input device|no default input|audio input/.test(m)) return { text: "I can't open the microphone. Check it in Settings → Voice.", fix: 'voice' };
  if (/screen recording|accessibility|not permitted|not allowed to send/.test(m)) return { text: 'macOS is blocking me from your screen or mouse. Allow it in Settings.', fix: 'computer' };
  const t = raw.replace(/\s+/g, ' ').trim();
  return { text: t.length > 220 ? `${t.slice(0, 217)}…` : t, fix: null };
}
