// Kydo — client-side rule-based filter.
// Belt-and-suspenders check applied AFTER the server-side judge.
// Catches deterministic violations (word count, banned phrases, names).

const BANNED_PHRASES = [
  'in the age of ai',
  'real art',
  'the human touch',
  'human touch',
  'the creative process',
  'creative process',
  'thought-provoking',
  'thought provoking',
  'deeper meaning',
  'at the end of the day',
  "in today's world",
  'art and technology',
  'blur the lines',
  'uncharted territory',
  'leverage',
  'synergy',
  'paradigm shift',
  'unleash',
];

const SOFTENER_STARTS = [
  'i wonder',
  "don't you think",
  'perhaps',
  'what if',
  'i was wondering',
  'maybe',
];

const SPEAKER_NAMES = ['pablo', 'robert', 'honey', 'hodgin', 'flight404'];

const COMPLIMENT_STARTS = /^(great|wonderful|amazing|brilliant|fascinating|incredible|beautiful)/i;

export const MAX_WORDS = 18;

export function checkQuestion(text) {
  const t = (text ?? '').trim();
  if (!t) return { ok: false, reason: 'empty' };

  const lower = t.toLowerCase();

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > MAX_WORDS) {
    return { ok: false, reason: `over ${MAX_WORDS} words (${words.length})` };
  }

  for (const phrase of BANNED_PHRASES) {
    // Word-boundary-ish match
    const re = new RegExp(`(^|\\W)${escape(phrase)}(\\W|$)`, 'i');
    if (re.test(lower)) {
      return { ok: false, reason: `banned phrase: "${phrase}"` };
    }
  }

  for (const softener of SOFTENER_STARTS) {
    if (lower.startsWith(softener)) {
      return { ok: false, reason: `starts with softener: "${softener}"` };
    }
  }

  for (const name of SPEAKER_NAMES) {
    const regex = new RegExp(`\\b${name}\\b`, 'i');
    if (regex.test(t)) {
      return { ok: false, reason: `speaker name: "${name}"` };
    }
  }

  if (/^how\b/i.test(t)) {
    return { ok: false, reason: 'starts with "How"' };
  }

  if (COMPLIMENT_STARTS.test(t)) {
    return { ok: false, reason: 'compliment opener' };
  }

  return { ok: true, reason: 'pass' };
}

const STOP = new Set([
  'about','after','again','against','among','around','because','before',
  'being','between','could','during','enough','every','first','from',
  'have','here','into','make','makes','made','more','most','much',
  'never','only','other','over','same','should','some','such','take',
  'takes','than','that','their','them','then','there','these','they',
  'thing','things','this','those','through','under','until','very',
  'want','were','what','when','where','which','while','will','with',
  'work','works','worked','would','your','question','sentence','process',
  'something','because','really','always','still','always','still','also',
]);

/** Crude noun-keyword extraction for topic cooldown. */
export function extractTopicKeywords(text) {
  return [...new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 4 && !STOP.has(w))
  )].slice(0, 5);
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
