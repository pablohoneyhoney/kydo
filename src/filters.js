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

// High-frequency content words that pass the basic stopword filter but are NOT
// notable — they don't inform a question. Used only by pickNotableKeyword.
const COMMON = new Set([
  'right','little','behind','school','letter','letters','number','numbers',
  'thing','things','stuff','kind','sort','part','parts','point','points',
  'place','places','side','fact','facts','case','cases','idea','ideas',
  'really','actually','basically','literally','totally','pretty','maybe',
  'probably','perhaps','quite','rather','almost','enough','around','before',
  'after','again','still','always','never','often','sometimes','usually',
  'mostly','instead','anyway','though','although','because','since','while',
  'during','between','within','without','against','toward','towards',
  'getting','going','doing','having','being','trying','looking','talking',
  'saying','coming','making','taking','giving','putting','started','wanted',
  'needed','called','asked','looked','seemed','happened','think','thought',
  'thinks','knew','knows','mean','meant','means','wants','needs','feel',
  'felt','feels','seems','looks','gets','came','went','said','says','tell',
  'tells','told','gonna','wanna','kinda','sorta','yeah','okay','alright',
  'better','worse','worst','more','most','less','least','much','many','every',
  'each','both','either','neither','another','other','others','same',
  'different','certain','clear','simple','good','great','nice','cool','weird',
  'crazy','interesting','important','special','normal','regular','usual',
  'common','similar','people','person','guys','everyone','everybody',
  'someone','somebody','anyone','anybody','nobody','something','anything',
  'everything','nothing','first','second','third','again','today','tonight',
  'yesterday','tomorrow','little','about','their','there','these','those',
  'whole','entire','actual','exactly','basically','obviously','definitely',
]);

/**
 * Pick the single most notable word from a chunk — the kind of word that could
 * inform the next question. Filters stopwords + common chatter, requires a bit of
 * length, and rewards proper-noun-like capitalization (Houdini, Maya, Barbarian).
 * Returns a lowercase word, or null if nothing notable is present.
 */
export function pickNotableKeyword(text) {
  if (!text) return null;
  let best = null;
  let bestScore = -1;
  for (const raw of text.split(/\s+/)) {
    const clean = raw.replace(/[^A-Za-z]/g, '');
    if (clean.length < 5) continue;
    const lower = clean.toLowerCase();
    if (STOP.has(lower) || COMMON.has(lower)) continue;
    let score = clean.length;                   // longer ~ more substantial
    if (/^[A-Z][a-z]/.test(clean)) score += 4;  // proper-noun-ish bonus
    if (score > bestScore) { bestScore = score; best = lower; }
  }
  return best;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
