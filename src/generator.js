// Kydo — client-side generation coordinator.
// Calls /api/generate, applies a belt-and-suspenders local filter,
// tracks topic cooldown, falls back to the vault when needed.

import { checkQuestion, extractTopicKeywords } from './filters.js';

const TOPIC_COOLDOWN_MS = 20 * 60 * 1000; // 20 min
const MAX_RETRIES = 2; // retry generation up to 2 more times after initial attempt

// Rotated each fire so consecutive questions take structurally different shapes —
// the strongest lever against the whole session sounding the same ("If… If… If…").
const FORMS = [
  'Form this line as a flat declarative statement — no question mark.',
  'Form this line by demanding the definition of a word they leaned on.',
  'Form this line as a comparison to another era, medium, or craft.',
  'Form this line by naming a cost or contradiction they are glossing over.',
  'Form this line around something concrete and physical, not abstract.',
  'Form this line as a short either/or.',
  'Form this line toward the audience or the wider field, not the two speakers.',
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Generator {
  constructor({ vault, onLog }) {
    this.vault = vault;
    this.onLog = onLog || (() => {});
    this.recentTopics = []; // [{ word, t }]
    this.recentlyFiredFromVault = [];
    this.recentQuestions = []; // session questions, so we never repeat or echo one
    this.formQueue = [];       // shuffled FORMS indices, refilled when empty
  }

  nextForm() {
    if (this.formQueue.length === 0) {
      this.formQueue = shuffle([...FORMS.keys()]);
    }
    return FORMS[this.formQueue.shift()];
  }

  recordQuestion(q) {
    this.recentQuestions.push(q);
    // Keep the whole session (capped generously) so questions stay distinct across
    // the entire talk, not just the last few.
    if (this.recentQuestions.length > 40) this.recentQuestions.shift();
  }

  recordQuestion(q) {
    this.recentQuestions.push(q);
    // Keep the whole session (capped generously) so questions stay distinct across
    // the entire talk, not just the last few.
    if (this.recentQuestions.length > 40) this.recentQuestions.shift();
  }

  pruneTopics() {
    const cutoff = Date.now() - TOPIC_COOLDOWN_MS;
    this.recentTopics = this.recentTopics.filter((e) => e.t >= cutoff);
  }

  getRecentTopicWords() {
    this.pruneTopics();
    return [...new Set(this.recentTopics.map((e) => e.word))];
  }

  recordTopics(words) {
    const t = Date.now();
    for (const word of words) {
      this.recentTopics.push({ word, t });
    }
  }

  pickFromVault() {
    const candidates = this.vault
      .map((q, i) => ({ q, i }))
      .filter(({ i }) => !this.recentlyFiredFromVault.includes(i));
    const pool = candidates.length > 0
      ? candidates
      : this.vault.map((q, i) => ({ q, i }));
    const choice = pool[Math.floor(Math.random() * pool.length)];
    this.recentlyFiredFromVault.push(choice.i);
    const cap = Math.min(8, Math.floor(this.vault.length / 2));
    if (this.recentlyFiredFromVault.length > cap) {
      this.recentlyFiredFromVault.shift();
    }
    return choice.q;
  }

  async generate({ transcript }) {
    const recentTopics = this.getRecentTopicWords();
    const formDirective = this.nextForm(); // one form per fire (held across retries)

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const r = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transcript, recentTopics, recentQuestions: this.recentQuestions, formDirective }),
        });

        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          this.onLog({ stage: 'generate-fail', attempt, status: r.status, detail });
          // 503 = no key, never going to work — bail to vault immediately.
          if (r.status === 503) break;
          continue;
        }

        const { question, judge } = await r.json();

        // Belt-and-suspenders local filter — catches violations the judge missed.
        const local = checkQuestion(question);
        if (!local.ok) {
          this.onLog({
            stage: 'local-filter-reject',
            attempt,
            question,
            reason: local.reason,
          });
          continue;
        }
        if (judge && judge.passed === false) {
          this.onLog({
            stage: 'judge-reject',
            attempt,
            question,
            reason: judge.reason,
          });
          continue;
        }

        // Accepted.
        const topics = extractTopicKeywords(question);
        this.recordTopics(topics);
        this.recordQuestion(question);
        this.onLog({
          stage: 'accept',
          attempt,
          question,
          topics,
          judge,
        });
        return { source: 'llm', question, attempts: attempt + 1 };
      } catch (e) {
        this.onLog({
          stage: 'generate-error',
          attempt,
          error: String(e?.message || e),
        });
      }
    }

    // Fallback to vault
    const question = this.pickFromVault();
    const topics = extractTopicKeywords(question);
    this.recordTopics(topics);
    this.recordQuestion(question);
    this.onLog({ stage: 'vault-fallback', question });
    return { source: 'vault', question };
  }
}
