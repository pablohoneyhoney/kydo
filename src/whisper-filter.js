// Kydo — Whisper hallucination filter.
//
// Whisper has well-known failure modes on silence or low-level audio: it produces
// training-data leftovers like "Thank you for watching!", "Subtitles by the Amara.org
// community", random YouTube-channel phrases, Spanish-blog URLs ("www.Flydreamers.com"),
// and music notations. These poison the rolling buffer and fool the mid-sentence guard.
//
// cleanChunk(text) returns either the chunk with hallucinations stripped, or '' if the
// chunk is entirely junk. main.js drops empty results without updating the buffer or the
// speech-detected timestamp.

const HALLUCINATIONS = [
  // YouTube / video-platform sign-offs
  /\bthank ?you (so much )?for watching!?/gi,
  /\bthanks for watching!?/gi,
  /\bthanks for listening!?/gi,
  /\bsubscribe to (the |my )?channel\b!?/gi,
  /\bdon'?t forget to subscribe\b!?/gi,
  /\bplease subscribe\b!?/gi,
  /\blike and subscribe\b!?/gi,
  /\bsee you (in the )?next (video|episode)\b!?/gi,
  /\bsubtitles? by the amara\.org community\b/gi,
  /\bsubtitled by\b[^.!?]*/gi,
  /\btranscription by\b[^.!?]*/gi,

  // Goodbyes that show up with no prompt
  /^bye[\s,!.-]*bye!?\.?$/gi,
  /^bye!?\.?$/gi,

  // The Spanish-blog URL Whisper loves to hallucinate
  /\bwww\.flydreamers\.com\b/gi,
  /\bflydreamers\.com\b/gi,

  // Music / non-speech notations
  /\[música[^\]]*\]/gi,
  /\[music\]/gi,
  /\(music\)/gi,
  /\[applause\]/gi,
  /\(applause\)/gi,
  /\[laughter\]/gi,
  /♪[^♪]*♪/g,
  /♫[^♫]*♫/g,
];

// After hallucination removal, treat as junk if what remains is just one or two
// stock filler words alone (Whisper produces "you." or "thanks" on silent chunks).
const TRIVIAL_RESIDUE = [
  /^you[.!?]?$/i,
  /^thanks[.!?]?$/i,
  /^thank you[.!?]?$/i,
  /^\.+$/,
  /^okay[.!?]?$/i,
  /^uh[.!?]?$/i,
  /^um[.!?]?$/i,
];

const ONLY_PUNCT = /^[\s.,!?·…\-—]*$/;

export function cleanChunk(text) {
  if (!text) return '';
  let cleaned = text;
  for (const re of HALLUCINATIONS) {
    cleaned = cleaned.replace(re, ' ');
  }
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  if (!cleaned) return '';
  if (ONLY_PUNCT.test(cleaned)) return '';
  for (const re of TRIVIAL_RESIDUE) {
    if (re.test(cleaned)) return '';
  }
  return cleaned;
}

export function isHallucination(text) {
  return cleanChunk(text) === '';
}
