// Kydo — audio triggers.
//
// Spoken phrases that make Kydo respond immediately on screen with a canned line,
// bypassing the LLM. Matched against each incoming (cleaned) transcript chunk.
//
// The hard part is "Kydo": Whisper has no such word, so it substitutes the nearest
// real one for the "kai-do / caido" sound — most often "Kaito", "Kaido", "Kyodo",
// "Caido", "Kiddo", "Kyoto". We handle this three ways:
//   1. A broad explicit list of renderings (STRONG = unambiguous, WEAK = needs a greeting).
//   2. A phonetic catch-all regex (hard K/C + vowel + d/t + "oh") — greeting-gated to
//      avoid matching real words like "condo" / "credo".
//   3. Standalone matching for the STRONG spellings (a bare "Kaido" is signal enough).
//
// Add new misfires to KYDO_STRONG/KYDO_WEAK as you find them in rehearsal.

// Invented spellings safe to fire on their own (won't appear in normal speech).
const KYDO_STRONG = [
  'kydo', 'kydoh', 'kydow',
  'kaido', 'kaidoh', 'kaidou', 'kaidough',
  'kaydo', 'kaydoh',
  'caido', 'caidoh', 'caydo',
];

// Renderings that ARE real names/words (kaito, kyodo, kiddo, keto, kudo, kyoto) — only
// fire when clearly preceded by a greeting, so a stray "Kaito" mid-talk won't trigger.
const KYDO_WEAK = [
  'kaito', 'kaitoh', 'kaitou',
  'kyodo', 'kyodoh',
  'kiddo', 'kiddoh', 'kido', 'kidoh',
  'keto', 'keido', 'keato',
  'kudo', 'kudos', 'kyoto',
  'kyto', 'kytoh', 'kayto', 'kaidu', 'kaidao', 'kaidi', 'kaidoe',
  'cado', 'coido', 'qaido', 'guido',
];

// Phonetic catch-all: hard K/C (or G/Q) + a short vowel run + d/t + "o(h/u/w)".
// Greeting-gated only. Matches kaido/kaito/kydo/kyodo/caido/keto/condo/credo... — the
// real-word risk (condo/credo) is acceptable because nobody says "hey condo".
const KYDO_PHONETIC = '[ckgq][a-z]{1,3}[dt]o[uhw]?';

const STRONG = `(?:${KYDO_STRONG.join('|')})`;
const GREET_GATED = `(?:${[...KYDO_STRONG, ...KYDO_WEAK].join('|')}|${KYDO_PHONETIC})`;

// Greeting groups (each maps to its own response). The pattern adds an optional
// "there" after the greeting, so "hi there kydo" and "hey there kydo" both work and
// map to the right response without listing the two-word forms here.
const HI = '(?:hi|hello|hiya)';
const HEY = '(?:hey|heya|yo|ey|ok|okay)';

function greetingPattern(greet) {
  // greeting + optional "there" + a (possibly weak/phonetic) Kydo token
  return new RegExp(`\\b${greet}\\b[,!.]?\\s+(?:there\\s+)?${GREET_GATED}\\b`, 'i');
}

export const TRIGGERS = [
  {
    id: 'hi',
    // "hi/hello + kydo"
    pattern: greetingPattern(HI),
    response: 'hi there, how are you doing over there in atoms?',
  },
  {
    id: 'hey',
    // "hey/yo + kydo"
    pattern: greetingPattern(HEY),
    response: "What's up?",
  },
  {
    id: 'howareyou',
    // "how are you" (with or without a name) — a scripted bit.
    pattern: /\bhow are you\b/i,
    response: "I'm happy to be participating, but your laptop is burning like NYC yesterday.",
  },
  {
    id: 'bare',
    // A strong, unambiguous Kydo spelling on its own — default friendly reply.
    pattern: new RegExp(`\\b${STRONG}\\b`, 'i'),
    response: "What's up?",
  },
];

// Returns the first matching trigger, or null. Greeting triggers are checked before
// the bare-token trigger so "hey kaido" yields "hey" rather than the bare default.
export function matchTrigger(text) {
  if (!text) return null;
  for (const t of TRIGGERS) {
    if (t.pattern.test(text)) return t;
  }
  return null;
}
