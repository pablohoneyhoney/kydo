// Kydo — client-side generation coordinator.
// Calls /api/generate, applies a belt-and-suspenders local filter,
// tracks topic cooldown, falls back to the vault when needed.

import { checkQuestion, extractTopicKeywords } from './filters.js';

const TOPIC_COOLDOWN_MS = 20 * 60 * 1000; // 20 min
const MAX_RETRIES = 2; // retry generation up to 2 more times after initial attempt

export class Generator {
  constructor({ vault, onLog }) {
    this.vault = vault;
    this.onLog = onLog || (() => {});
    this.recentTopics = []; // [{ word, t }]
    this.recentlyFiredFromVault = [];
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

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const r = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transcript, recentTopics }),
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
    this.onLog({ stage: 'vault-fallback', question });
    return { source: 'vault', question };
  }
}
