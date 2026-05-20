// Kydo — rolling transcript buffer.
//
// Holds the last N milliseconds of transcribed text, indexed by timestamp.
// In Phase 3, getRecent() returns the context window for question generation.

const DEFAULT_WINDOW_MS = 90_000; // last 90 seconds

export class TranscriptBuffer {
  constructor({ windowMs = DEFAULT_WINDOW_MS } = {}) {
    this.windowMs = windowMs;
    this.entries = []; // [{ t, text }]
  }

  add(text) {
    if (!text) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    this.entries.push({ t: Date.now(), text: clean });
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - this.windowMs;
    while (this.entries.length > 0 && this.entries[0].t < cutoff) {
      this.entries.shift();
    }
  }

  /** Concatenated text within the rolling window. */
  getRecent() {
    this.prune();
    return this.entries.map((e) => e.text).join(' ');
  }

  /** How many seconds of audio is currently in the buffer? */
  spanSeconds() {
    this.prune();
    if (this.entries.length === 0) return 0;
    return Math.round((Date.now() - this.entries[0].t) / 1000);
  }

  /** Recent entries with timestamps — used by the debug overlay. */
  entriesArray() {
    this.prune();
    return [...this.entries];
  }

  clear() {
    this.entries = [];
  }
}
