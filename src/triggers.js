// Kydo — audio triggers.
//
// Spoken phrases that make Kydo respond immediately on screen with a canned line,
// bypassing the LLM. Matched against each incoming (cleaned) transcript chunk.
//
// IMPORTANT: Whisper frequently mishears "Kydo" — it has no such word in its training
// data, so it reaches for the nearest real one ("Kaido" from One Piece, "kiddo", "Kyoto",
// "keto"...). We match a generous list of renderings. When you discover a new misfire
// during rehearsal, add it to KYDO_VARIANTS and it'll just work.

const KYDO_VARIANTS = [
  'kydo', 'kydoh', 'kydow',
  'kaido', 'kaidoh', 'kaidou', 'kaidu',
  'kiddo', 'kiddoh', 'kido', 'kidoh',
  'keto', 'kyoto', 'kudo', 'kudos',
  'keido', 'keido', 'cado', 'caido',
  'kyto', 'kayto', 'coido', 'keato',
  'qaido', 'kaidao',
];

const KYDO = `(?:${KYDO_VARIANTS.join('|')})`;

// Build a trigger from a leading word ("hi" / "hey") + a Kydo-like token.
// Tolerates trailing comma/exclamation and any case.
function greeting(word) {
  return new RegExp(`\\b${word}[,!.]?\\s+${KYDO}\\b`, 'i');
}

export const TRIGGERS = [
  {
    id: 'hi',
    pattern: greeting('hi'),
    response: 'hi there, how are you doing over there in atoms?',
  },
  {
    id: 'hey',
    pattern: greeting('hey'),
    response: "What's up?",
  },
];

// Returns the first matching trigger, or null. "hey" is checked before "hi"
// only matters if both could match the same text — they can't here.
export function matchTrigger(text) {
  if (!text) return null;
  for (const t of TRIGGERS) {
    if (t.pattern.test(text)) return t;
  }
  return null;
}
