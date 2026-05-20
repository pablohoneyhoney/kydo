// Kydo — rehearsal page.
// - Lets Pablo paste a simulated transcript and generate candidate questions through
//   the same /api/generate pipeline used in production.
// - Inline edit / add / delete the vault, saved to src/vault.json via /api/vault.

import { checkQuestion } from './filters.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// --- Health -----------------------------------------------------------
const statusDot = $('#status-dot');
const statusText = $('#status-text');

async function refreshHealth() {
  try {
    const r = await fetch('/api/health');
    if (!r.ok) throw new Error('not ok');
    const h = await r.json();
    const parts = [];
    if (h.hasAnthropicKey) parts.push('anthropic ✓');
    else parts.push('anthropic ✗');
    if (h.hasOpenAIKey) parts.push('openai ✓');
    else parts.push('openai ✗');
    statusText.textContent = `phase ${h.phase} · ${parts.join(' · ')}`;
    statusDot.classList.remove('ok', 'warn', 'bad');
    statusDot.classList.add(h.hasAnthropicKey ? 'ok' : 'warn');
  } catch {
    statusText.textContent = 'backend offline';
    statusDot.classList.remove('ok', 'warn');
    statusDot.classList.add('bad');
  }
}

// --- Vault editor ----------------------------------------------------
let vault = [];
let vaultDirty = false;
const vaultEl = $('#vault');
const vaultCount = $('#vault-count');
const saveFeedback = $('#save-feedback');

async function loadVault() {
  const r = await fetch('/api/vault');
  if (!r.ok) {
    setFeedback('failed to load vault', 'bad');
    return;
  }
  vault = await r.json();
  vaultDirty = false;
  renderVault();
}

function renderVault() {
  vaultCount.textContent = `(${vault.length})`;
  vaultEl.innerHTML = '';
  vault.forEach((line, i) => {
    const li = document.createElement('li');
    const ta = document.createElement('textarea');
    ta.className = 'line';
    ta.value = line;
    ta.rows = 1;
    ta.addEventListener('input', (e) => {
      vault[i] = e.target.value;
      vaultDirty = true;
      autosize(e.target);
      setFeedback('unsaved changes');
    });
    ta.addEventListener('focus', () => autosize(ta));
    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'remove';
    del.textContent = '×';
    del.addEventListener('click', () => {
      vault.splice(i, 1);
      vaultDirty = true;
      renderVault();
      setFeedback('removed (unsaved)');
    });
    li.appendChild(ta);
    li.appendChild(del);
    vaultEl.appendChild(li);
    autosize(ta);
  });
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function setFeedback(msg, level = '') {
  saveFeedback.textContent = msg;
  saveFeedback.classList.remove('ok', 'bad');
  if (level) saveFeedback.classList.add(level);
}

$('#add-line').addEventListener('click', () => {
  vault.push('');
  vaultDirty = true;
  renderVault();
  // Focus the new entry
  const last = vaultEl.querySelector('li:last-child .line');
  if (last) last.focus();
  setFeedback('new line added (unsaved)');
});

$('#save-vault').addEventListener('click', async () => {
  const cleaned = vault.map((l) => l.trim()).filter(Boolean);
  try {
    const r = await fetch('/api/vault', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cleaned),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setFeedback(`save failed: ${j.error || r.statusText}`, 'bad');
      return;
    }
    vault = cleaned;
    vaultDirty = false;
    renderVault();
    setFeedback(`saved · ${cleaned.length} lines`, 'ok');
  } catch (e) {
    setFeedback(`save error: ${e.message}`, 'bad');
  }
});

window.addEventListener('beforeunload', (e) => {
  if (vaultDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// --- Generation flow -------------------------------------------------
const transcriptEl = $('#transcript');
const candidateCard = $('#candidate-card');
const candidateText = $('#candidate-text');
const candidateSource = $('#candidate-source');
const candidateJudge = $('#candidate-judge');
const candidateFilter = $('#candidate-filter');
const candidateAttempts = $('#candidate-attempts');
const candidateReason = $('#candidate-reason');
const generateBtn = $('#generate');
const regenerateBtn = $('#regenerate');
const acceptBtn = $('#accept');
const rejectBtn = $('#reject');
const historyEl = $('#history');
const historyCount = $('#history-count');

let history = [];
let currentCandidate = null;
let sessionQuestions = []; // everything generated this session — fed back so it won't repeat

$('#clear-transcript').addEventListener('click', () => {
  transcriptEl.value = '';
  transcriptEl.focus();
});

async function generate() {
  const transcript = transcriptEl.value.trim();
  generateBtn.disabled = true;
  generateBtn.textContent = 'generating…';
  candidateCard.hidden = false;
  candidateText.textContent = '';
  candidateReason.textContent = '';
  candidateSource.textContent = '…';
  candidateJudge.textContent = '…';
  candidateFilter.textContent = '…';
  candidateAttempts.textContent = '…';
  setPill(candidateSource, '');
  setPill(candidateJudge, '');
  setPill(candidateFilter, '');
  setPill(candidateAttempts, '');

  try {
    const r = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript, recentTopics: [], recentQuestions: sessionQuestions.slice(-12) }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (r.status === 503) {
        candidateText.textContent = '(no Anthropic key — set ANTHROPIC_API_KEY in .env.local)';
        candidateReason.textContent = '';
        candidateSource.textContent = 'no-key';
        setPill(candidateSource, 'bad');
        return;
      }
      candidateText.textContent = '(generation failed)';
      candidateReason.textContent = j.detail || j.error || `${r.status}`;
      setPill(candidateSource, 'bad');
      candidateSource.textContent = `error ${r.status}`;
      return;
    }
    const { question, judge } = await r.json();
    currentCandidate = { question, judge };
    if (question) sessionQuestions.push(question); // remember so we don't regenerate it
    candidateText.textContent = question;

    candidateSource.textContent = 'llm';
    setPill(candidateSource, 'ok');

    if (judge) {
      candidateJudge.textContent = judge.passed ? 'judge: pass' : 'judge: reject';
      setPill(candidateJudge, judge.passed ? 'ok' : 'bad');
      if (!judge.passed) candidateReason.textContent = `judge — ${judge.reason}`;
    } else {
      candidateJudge.textContent = 'judge: —';
    }

    const local = checkQuestion(question);
    candidateFilter.textContent = `filter: ${local.ok ? 'pass' : local.reason}`;
    setPill(candidateFilter, local.ok ? 'ok' : 'bad');
    if (!local.ok && !candidateReason.textContent) {
      candidateReason.textContent = `filter — ${local.reason}`;
    }
    candidateAttempts.textContent = `${question.split(/\s+/).filter(Boolean).length} words`;
  } catch (e) {
    candidateText.textContent = '(error)';
    candidateReason.textContent = String(e.message || e);
    setPill(candidateSource, 'bad');
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate candidate';
  }
}

function setPill(el, level) {
  el.classList.remove('ok', 'bad', 'warn');
  if (level) el.classList.add(level);
}

generateBtn.addEventListener('click', generate);
regenerateBtn.addEventListener('click', generate);

acceptBtn.addEventListener('click', () => {
  if (!currentCandidate) return;
  vault.push(currentCandidate.question);
  vaultDirty = true;
  renderVault();
  pushHistory({ ok: true, text: currentCandidate.question, why: 'accepted → vault' });
  setFeedback('added to vault (unsaved)');
  currentCandidate = null;
  candidateCard.hidden = true;
});

rejectBtn.addEventListener('click', () => {
  if (!currentCandidate) return;
  pushHistory({ ok: false, text: currentCandidate.question, why: 'rejected' });
  currentCandidate = null;
  candidateCard.hidden = true;
});

function pushHistory(entry) {
  history.unshift(entry);
  if (history.length > 30) history.pop();
  historyCount.textContent = `(${history.length})`;
  historyEl.innerHTML = '';
  for (const h of history) {
    const li = document.createElement('li');
    const glyph = document.createElement('span');
    glyph.className = `glyph ${h.ok ? 'ok' : 'bad'}`;
    glyph.textContent = h.ok ? '✓' : '✗';
    const body = document.createElement('div');
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = h.text;
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = h.why;
    body.appendChild(text);
    body.appendChild(why);
    li.appendChild(glyph);
    li.appendChild(body);
    historyEl.appendChild(li);
  }
}

// --- Boot ------------------------------------------------------------
refreshHealth();
loadVault();
setInterval(refreshHealth, 30_000);

// Keyboard: Cmd/Ctrl+Enter to generate, Cmd/Ctrl+S to save vault
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    generate();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    $('#save-vault').click();
  }
});
