// Noli's first meeting with the user, and with anyone else it hears.
// Pure helpers (no Tauri) so they can be unit-tested.

export type NameAnswer =
  | { kind: 'name'; name: string }
  /** "it's me" — the main user, sounding different */
  | { kind: 'self' }
  /** doesn't want to say */
  | { kind: 'refuse' }
  /** couldn't find a name in it */
  | { kind: 'none' };

const STOP = new Set(
  (
    'a an the just not sorry fine good great ok okay yes yeah yep no nope here there your you my me mine it its is am are was were be ' +
    'hello hi hey hiya noli phantom thanks thank well um uh oh so called name back ready busy tired happy sad sure nobody someone ' +
    'somebody anyone who what why how going doing trying user owner human person guy girl man woman boy friend speaking talking ' +
    'and but or also too again now today really very still only that this these those of for to from with in on at by as ' +
    'nice cool complicated secret private weird hard difficult late early none hungry bored confused lost new old home cold hot ' +
    'alright awake asleep glad excited curious afraid scared fine'
  ).split(' '),
);

const LEAD_INS = [
  'my name is',
  "my name's",
  'my names',
  'the name is',
  "the name's",
  "name's",
  'name is',
  'i am called',
  "i'm called",
  'im called',
  'you can call me',
  'people call me',
  'they call me',
  'just call me',
  'call me',
  'this is',
  "it's",
  'its',
  'it is',
  'i am',
  "i'm",
  'im',
];

const REFUSAL = /\b(skip( it| this)?|rather not|i don'?t want to|not (gonna|going to) (say|tell)|none of your business|not telling|no thanks|never ?mind|not now|maybe later|ask me later|i won'?t tell)\b/i;
const SELF = /^(?:(?:it'?s|it is|that'?s|that was|this is)\s+)?(?:just\s+|only\s+|still\s+)?me\b/i;

const RELATION =
  /\b(?:my|our)\s+(?:best\s+)?(?:friend|buddy|mate|brother|sister|sibling|mom|mum|mother|dad|father|wife|husband|partner|boyfriend|girlfriend|fianc[ée]e?|son|daughter|kid|child|roommate|flatmate|housemate|colleague|coworker|co-worker|cousin|uncle|aunt|grandma|grandpa|grandmother|grandfather|neighbou?r|boss|teacher|student)[\s,]+(.+)/i;

const wordLike = (w: string) => /^[\p{L}][\p{L}'’.-]*$/u.test(w) && w.length <= 20;

function titleCase(w: string): string {
  // keep deliberate capitalisation (McKenzie, DeShawn); fix all-lower / all-upper
  if (w !== w.toLowerCase() && w !== w.toUpperCase()) return w;
  return w
    .toLowerCase()
    .split(/([-'’])/)
    .map((p) => (p.length > 0 && !/[-'’]/.test(p) ? p[0].toUpperCase() + p.slice(1) : p))
    .join('');
}

/** Up to three name-like words from the start of `rest`, stopping at punctuation or filler. */
function takeName(rest: string): string | null {
  const head = rest.split(/[,.!?;:()"“”…]|\s[-–—]\s/)[0] ?? '';
  const words = head.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const raw of words) {
    const w = raw.replace(/^['’]+|['’.]+$/g, '');
    if (!w || !wordLike(w) || STOP.has(w.toLowerCase())) break;
    out.push(titleCase(w));
    if (out.length === 3) break;
  }
  const name = out.join(' ');
  return name && name.length <= 40 ? name : null;
}

/** Understands answers to "what's your name?" / "who's speaking?". */
export function parseNameAnswer(input: string): NameAnswer {
  let t = input
    .trim()
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!t) return { kind: 'none' };
  if (REFUSAL.test(t) || /^(no|nope|nah)[.!]*$/i.test(t)) return { kind: 'refuse' };
  const self = SELF.exec(t);
  if (self) {
    // "it's me, Ada" names them; "it's just me" doesn't
    const name = takeName(t.slice(self[0].length).replace(/^[\s,.!-]+/, ''));
    return name ? { kind: 'name', name } : { kind: 'self' };
  }
  // drop a greeting in front: "Hi Noli, I'm Ada"
  t = t.replace(/^(?:(?:hi|hello|hey|hiya|yo|oh|um+|uh+|well|okay|ok|so)\b[\s,.!]*)+(?:noli\b[\s,.!]*)?/i, '');
  const lower = t.toLowerCase();
  // someone answering for them: "that's my friend Bob"
  const rel = RELATION.exec(t);
  if (rel) {
    const name = takeName(rel[1]);
    if (name) return { kind: 'name', name };
  }
  // "Ada here" / "Ada is my name"
  const tail = /^(.+?)\s+(?:here|speaking|is my name)\b/i.exec(t);
  for (const lead of LEAD_INS) {
    const re = new RegExp(`(?:^|\\s)${lead.replace(/'/g, "['’]")}\\s+(.+)`, 'i');
    const m = re.exec(t);
    if (m) {
      const name = takeName(m[1]);
      // "I'm not sure", "it's complicated": nothing usable
      return name ? { kind: 'name', name } : { kind: 'none' };
    }
  }
  if (tail) {
    const name = takeName(tail[1]);
    if (name) return { kind: 'name', name };
  }
  // a bare answer: "Ada", "Ada Lovelace."
  const bare = lower.replace(/[.!?,]+$/, '').trim();
  if (bare.split(/\s+/).length <= 3) {
    const name = takeName(t);
    if (name && name.split(' ').length === bare.split(/\s+/).length) return { kind: 'name', name };
  }
  return { kind: 'none' };
}

export const sameName = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const pick = <T,>(list: readonly T[], rand = Math.random): T => list[Math.floor(rand() * list.length)];

/** What Noli says the very first time it appears. */
export const INTRO_LINES = [
  'Oh. Hello there.',
  "I'm Noli. I fell out of a star and landed in your computer.",
  'I can talk with you, look at your screen when you let me, open apps, and help with whatever you are doing.',
  'But first. What should I call you?',
] as const;

export function askNameHint(voiceOn: boolean, pttKey: string): string {
  return voiceOn ? `Hold ${pttKey} and say your name, or type it below.` : 'Type your name below.';
}

export const nameRetry = (rand = Math.random) => pick(["Sorry, I didn't catch your name. Just tell me your name.", 'Hm. The static ate that one. What is your name?', 'One more time? Just your name.'], rand);

export const greetOwner = (name: string, rand = Math.random) =>
  pick([`${name}. Nice to meet you, ${name}. I'll remember that.`, `${name}. Good name. I'm writing it somewhere safe.`, `Hello, ${name}. I won't forget you now.`], rand);

export const ownerRefused = "Fine. Keep your secrets. You can tell me your name whenever you like.";

export const askStranger = (rand = Math.random) => pick(["Wait. I don't recognise that voice. Who's speaking?", "Hold on. You're not someone I know. Who are you?", 'That voice is new. Who am I talking to?'], rand);

export const greetStranger = (name: string, rand = Math.random) =>
  pick([`Nice to meet you, ${name}. I'll remember your voice.`, `${name}. Noted. I'll know you next time.`, `Hello, ${name}. Your voice is safe with me.`], rand);

export const ownerSoundedDifferent = (name: string) => `Oh, it's you, ${name}. You sounded different. I'll remember that.`;

export const strangerRefused = 'A mystery guest, then. Fine.';

/** Memory entries Noli keeps about people. */
export const ownerMemory = (name: string) => `The user's name is ${name}.`;
export const strangerMemory = (name: string, owner: string | null) =>
  owner ? `${name} is someone else who sometimes talks to Noli (not ${owner}, the main user). Noli knows ${name}'s voice.` : `${name} is someone who sometimes talks to Noli. Noli knows ${name}'s voice.`;
