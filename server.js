// Kydo — backend proxy.
// Phase 1: stub.
// Phase 2: /api/transcribe — chunked Whisper.
// Phase 3 (current): /api/generate — Anthropic two-pass (Sonnet generate + Haiku judge).

import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildSystemPrompt, buildJudgePrompt } from './prompt.js';

// Load env with .env.local taking precedence over .env, and BOTH overriding any
// stray shell vars. Without override:true, an empty ANTHROPIC_API_KEY exported in
// the parent shell would silently shadow the real key from the file — a nasty,
// invisible failure right before a live event. The file is authoritative.
dotenv.config({ path: ['.env.local', '.env'], override: true });

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT_PATH = join(__dirname, 'src', 'vault.json');

const app = express();
app.use(express.json({ limit: '256kb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const GENERATOR_MODEL = process.env.KYDO_GENERATOR_MODEL || 'claude-sonnet-4-5';
const JUDGE_MODEL = process.env.KYDO_JUDGE_MODEL || 'claude-haiku-4-5';

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    phase: 3,
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    models: { generator: GENERATOR_MODEL, judge: JUDGE_MODEL },
  });
});

// --- Phase 4: shared state for phone remote -------------------------
// The display POSTs its state every ~1s; the phone GETs it.
// The phone POSTs commands; the display consumes them on its next poll.

const state = {
  // Display snapshot (last update wins)
  display: {
    updatedAt: 0,
    phase: 'unknown',
    nextInSeconds: 0,
    fired: 0,
    micState: 'unknown',
    lastQuestion: '',
    paused: false,
  },
  // Pending command from the phone — display picks it up and clears.
  command: null, // 'fire' | 'skip' | 'pause' | 'resume' | 'kill' | 'revive' | null
  commandAt: 0,
};

app.get('/api/state', (_req, res) => {
  res.json(state);
});

app.post('/api/state/display', (req, res) => {
  const incoming = req.body || {};
  state.display = {
    ...state.display,
    ...incoming,
    updatedAt: Date.now(),
  };
  res.json({ ok: true });
});

app.post('/api/control', (req, res) => {
  const action = (req.body && req.body.action) || '';
  const valid = new Set(['fire', 'skip', 'pause', 'resume', 'kill', 'revive']);
  if (!valid.has(action)) {
    return res.status(400).json({ error: 'unknown-action', valid: [...valid] });
  }
  state.command = action;
  state.commandAt = Date.now();
  res.json({ ok: true, action });
});

app.post('/api/control/clear', (_req, res) => {
  state.command = null;
  state.commandAt = 0;
  res.json({ ok: true });
});

// --- Phase 4: vault editor (rehearsal page reads & writes this) -----
app.get('/api/vault', (_req, res) => {
  try {
    const data = JSON.parse(readFileSync(VAULT_PATH, 'utf-8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'read-fail', detail: String(e?.message || e) });
  }
});

app.put('/api/vault', (req, res) => {
  const incoming = req.body;
  // Validation: must be an array of non-empty strings, sane limits.
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: 'not-an-array' });
  }
  if (incoming.length > 300) {
    return res.status(400).json({ error: 'too-many', max: 300 });
  }
  const cleaned = [];
  for (const line of incoming) {
    if (typeof line !== 'string') {
      return res.status(400).json({ error: 'non-string-entry' });
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue; // silently drop blanks
    if (trimmed.length > 280) {
      return res.status(400).json({ error: 'line-too-long', limit: 280 });
    }
    cleaned.push(trimmed);
  }
  try {
    writeFileSync(VAULT_PATH, JSON.stringify(cleaned, null, 2) + '\n', 'utf-8');
    res.json({ ok: true, count: cleaned.length });
  } catch (e) {
    res.status(500).json({ error: 'write-fail', detail: String(e?.message || e) });
  }
});

// --- Phase 2: transcription ----------------------------------------
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'no-openai-key', text: '' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'no-file', text: '' });
  }

  try {
    const fd = new FormData();
    fd.append(
      'file',
      new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }),
      req.file.originalname || 'audio.webm'
    );
    fd.append('model', 'whisper-1');
    fd.append('language', 'en');
    fd.append('response_format', 'json');
    // Light proper-noun bias for accuracy. Deliberately NO "Flight404" — it made
    // Whisper hallucinate "www.Flight404.com" on quiet audio. The amplitude gate in
    // audio.js now prevents silent chunks reaching Whisper, but we keep this minimal.
    fd.append('prompt', 'Robert Hodgin, Houdini, Cinder, Rare Volume, Automattic, generative art.');

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });

    if (!r.ok) {
      const detail = await r.text();
      console.warn('[kydo] whisper failed', r.status, detail.slice(0, 200));
      return res.status(r.status).json({ error: 'whisper-fail', detail: detail.slice(0, 200), text: '' });
    }

    const json = await r.json();
    const text = (json.text || '').trim();
    res.json({ text });
  } catch (e) {
    console.error('[kydo] transcribe error', e);
    res.status(500).json({ error: 'fetch-fail', detail: String(e?.message || e), text: '' });
  }
});

// --- Phase 3: generation -------------------------------------------
async function callAnthropic({ model, system, user, maxTokens = 80 }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: user }],
  };
  if (system) body.system = system;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`anthropic-${r.status}: ${detail.slice(0, 200)}`);
  }
  const json = await r.json();
  const block = (json.content || []).find((c) => c.type === 'text');
  return (block?.text || '').trim();
}

app.post('/api/generate', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'no-anthropic-key' });
  }
  const { transcript = '', recentTopics = [], recentQuestions = [] } = req.body || {};

  try {
    const systemPrompt = buildSystemPrompt({ recentTopics, transcript, recentQuestions });

    const raw = await callAnthropic({
      model: GENERATOR_MODEL,
      system: systemPrompt,
      user: 'Write one line now. Just the line. No preamble.',
      maxTokens: 80,
    });

    // Strip surrounding quotes / whitespace / leading markdown
    const candidate = raw
      .replace(/^["'`*\s]+|["'`*\s]+$/g, '')
      .split('\n')[0]
      .trim();

    // Judge pass — failures here are non-fatal (we just note them).
    let judge = null;
    try {
      const judgement = await callAnthropic({
        model: JUDGE_MODEL,
        user: buildJudgePrompt(candidate),
        maxTokens: 80,
      });
      const trimmed = judgement.trim();
      const passed = /^PASS\b/i.test(trimmed);
      const reason = passed
        ? 'pass'
        : trimmed.replace(/^REJECT:\s*/i, '').trim() || 'rejected (no reason)';
      judge = { passed, reason };
    } catch (e) {
      // Judge errored — fall through with passed=null (client treats as pass)
      console.warn('[kydo] judge error', e?.message);
      judge = { passed: true, reason: `judge-error: ${e?.message}` };
    }

    res.json({ question: candidate, judge });
  } catch (e) {
    console.error('[kydo] generate error', e);
    res.status(500).json({ error: 'generate-fail', detail: String(e?.message || e) });
  }
});

const PORT = Number(process.env.PORT || 5175);
app.listen(PORT, () => {
  console.log(`kydo proxy listening on :${PORT} (phase 3)`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn('  WARNING: OPENAI_API_KEY not set — /api/transcribe will return 503');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  WARNING: ANTHROPIC_API_KEY not set — /api/generate will return 503');
  }
  console.log(`  generator: ${GENERATOR_MODEL}`);
  console.log(`  judge:     ${JUDGE_MODEL}`);
});
