// Kydo — Phase 3
// State machine + LLM-driven generation + vault fallback + mid-sentence guard.

import { setupUI } from './ui.js';
import { Mic } from './audio.js';
import { TranscriptBuffer } from './transcript.js';
import { Generator } from './generator.js';
import { cleanChunk } from './whisper-filter.js';
import { matchTrigger, TRIGGERS } from './triggers.js';
import { pickNotableKeywords } from './filters.js';
import vault from './vault.json';

// --- Config ---------------------------------------------------------
const params = new URLSearchParams(location.search);
const FAST = params.has('fast');
const NO_MIC = params.has('nomic');
const CYCLE_SECONDS = FAST ? 20 : 600; // 10 min between auto-questions (Cmd+Enter fires anytime)
const HOLD_SECONDS  = FAST ? 8  : 60;
const DEBUG         = params.has('debug') || FAST || import.meta.env.DEV;

// Mid-sentence guard — driven by mic amplitude, not transcript arrival.
// Whisper hallucinates on silence, so transcript-arrival is a lying signal.
// Amplitude can't lie about whether someone is speaking.
const SPEECH_QUIET_MS = 8_000;            // wait until at least this much silence to fire
const MAX_DEFER_MS    = 30_000;           // but never defer longer than this
const SPEECH_AMPLITUDE_THRESHOLD = 0.10;  // boosted mic level (0..1) that counts as speech

// --- UI -------------------------------------------------------------
const ui = setupUI({ debug: DEBUG });

// --- Transcript + Mic ----------------------------------------------
// 10-minute window to match the question cadence: Kydo contextualizes from the
// whole stretch of listening since its last question. Decoupled from chunk size
// (which only governs trigger latency).
const transcript = new TranscriptBuffer({ windowMs: 600_000 });
const mic = new Mic();
let micState = 'off';
let lastTranscriptAt = 0;  // for debug visibility only
let lastSpeechAt = 0;       // amplitude-based; this is what the guard reads
let prevTriggerChunk = '';  // last cleaned chunk, for boundary-spanning trigger match
// A single keyword after "listening_" that changes dynamically — each chunk swaps
// it to the best noun/verb heard, so it tracks the conversation in real time.
// A chunk with nothing notable leaves the current word in place.
function updateKeywords(chunkText) {
  const best = pickNotableKeywords(chunkText, 1)[0];
  if (best) ui.setKeyword(best);
}

mic.onAmplitude((avg) => {
  const boosted = Math.min(1, avg * 2.2);
  document.documentElement.style.setProperty('--mic', boosted.toFixed(3));
  if (boosted > SPEECH_AMPLITUDE_THRESHOLD) {
    lastSpeechAt = Date.now();
  }
});

mic.onTranscript((text) => {
  const cleaned = cleanChunk(text);
  if (!cleaned) {
    // Pure Whisper hallucination — drop without touching the buffer or any timestamp.
    logEvent({ type: 'transcript-dropped', raw: text });
    return;
  }
  transcript.add(cleaned);
  lastTranscriptAt = Date.now();
  ui.appendTranscript(cleaned);
  logEvent({ type: 'transcript', text: cleaned });

  // Surface keywords being heard — a live signal that Kydo is interpreting the room.
  updateKeywords(cleaned);

  // Audio trigger? Respond immediately with a canned line (bypasses the LLM).
  // Match across the previous + current chunk so a greeting split across the
  // ~3s boundary ("hey" | "Kydo") still catches. Cooldown prevents double-fire.
  const triggerWindow = (prevTriggerChunk + ' ' + cleaned).trim();
  prevTriggerChunk = cleaned;
  const trigger = matchTrigger(triggerWindow);
  if (trigger) fireTrigger(trigger);
});

mic.onError((err) => {
  // Per-chunk audio levels (gated or sent) — not errors; log quietly for tuning.
  // At the venue: __kydo.levels() prints recent silence vs speech averages so you
  // can set SILENCE_GATE_AVG (src/audio.js) between the two.
  if (err.stage === 'gated-silent' || err.stage === 'chunk-sent') {
    logEvent({ type: 'level', sent: err.stage === 'chunk-sent', avg: err.avg, peak: err.peak });
    return;
  }
  console.warn('[kydo] mic/transcribe error', err);
  if (err.stage === 'transcribe' && err.status === 503) {
    micState = 'no-key';
  }
});

// --- Generator ------------------------------------------------------
const generator = new Generator({
  vault,
  onLog: (event) => logEvent({ type: 'gen', ...event }),
});

// --- Scheduler ------------------------------------------------------
let fired = 0;
let nextFireAt = Date.now() + CYCLE_SECONDS * 1000;
let firingInProgress = false;
let killed = false;
let lastQuestionText = '';

function tick() {
  const remaining = Math.max(0, nextFireAt - Date.now());
  ui.setDebug({
    phase: ui.getPhase(),
    next: formatSeconds(remaining / 1000),
    fired,
    micState,
    bufferSpan: transcript.spanSeconds() + 's',
  });
  if (!killed && !paused && remaining <= 0 && ui.getPhase() === 'listening' && !firingInProgress) {
    fireWithGuard();
  }
}
setInterval(tick, 100);

// --- Remote (Phase 4): push state, consume commands -----------------
async function pushState() {
  const remainingMs = Math.max(0, nextFireAt - Date.now());
  try {
    await fetch('/api/state/display', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phase: ui.getPhase(),
        nextInSeconds: Math.round(remainingMs / 1000),
        fired,
        micState,
        lastQuestion: lastQuestionText,
        paused,
        killed,
      }),
    });
  } catch {
    // Backend may not be running — that's fine; display continues.
  }
}

async function pollCommands() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) return;
    const s = await r.json();
    if (!s.command) return;
    const action = s.command;
    // Clear server-side first so we don't double-execute on the next poll.
    await fetch('/api/control/clear', { method: 'POST' });
    handleCommand(action);
  } catch {
    /* offline backend is fine */
  }
}

function handleCommand(action) {
  logEvent({ type: 'remote', action });
  switch (action) {
    case 'fire':
      // Phone "Fire now" also bypasses the guard — it's a manual trigger.
      manualFire('phone');
      break;
    case 'skip':
      if (ui.getPhase() === 'question') {
        ui.setPhase('listening');
        nextFireAt = Date.now() + CYCLE_SECONDS * 1000;
      } else {
        nextFireAt = Date.now() + CYCLE_SECONDS * 1000;
      }
      break;
    case 'pause':
      if (!paused) pauseTimer();
      // Extend next-fire by 5 minutes
      nextFireAt = Math.max(nextFireAt, Date.now()) + 5 * 60 * 1000;
      break;
    case 'resume':
      if (paused) resumeTimer();
      break;
    case 'kill':
      killed = true;
      if (ui.getPhase() === 'question') ui.setPhase('listening');
      break;
    case 'revive':
      killed = false;
      nextFireAt = Date.now() + CYCLE_SECONDS * 1000;
      break;
  }
}

setInterval(pushState, 1000);
setInterval(pollCommands, 1500);

async function fireWithGuard() {
  firingInProgress = true;
  const start = Date.now();
  // Defer if amplitude has spiked recently (someone speaking), up to MAX_DEFER_MS.
  while (Date.now() - start < MAX_DEFER_MS) {
    const sinceSpeech = Date.now() - lastSpeechAt;
    if (lastSpeechAt === 0 || sinceSpeech >= SPEECH_QUIET_MS) break;
    await wait(500);
  }
  try {
    await fire();
  } finally {
    firingInProgress = false;
  }
}

async function fire() {
  // Kydo is composing — flip the state label while we generate + type.
  ui.setStateLabel('typing');
  // Run generator (may hit LLM or fall back to vault).
  const result = await generator.generate({ transcript: transcript.getRecent() });
  fired += 1;
  lastQuestionText = result.question;
  logEvent({ type: 'fire', source: result.source, question: result.question, attempts: result.attempts });
  await ui.showQuestion(result.question, HOLD_SECONDS * 1000); // resets label to 'listening' on exit
  nextFireAt = Date.now() + CYCLE_SECONDS * 1000;
}

// --- Mic startup ----------------------------------------------------
async function startMic() {
  if (NO_MIC) return;
  if (micState !== 'off') return;
  micState = 'starting';
  try {
    await mic.start();
    micState = 'live';
    document.body.classList.add('mic-active');
    ui.hideStartGate();
    console.log('[kydo] mic live');
  } catch (e) {
    micState = 'error';
    console.error('[kydo] mic failed', e);
    ui.showStartError(e?.message || String(e));
  }
}

ui.onStart(startMic);

// Manual fire bypasses the mid-sentence guard. If you press a key, you mean it.
function manualFire(source = 'key') {
  if (ui.getPhase() !== 'listening' || firingInProgress || killed) return;
  logEvent({ type: 'manual-fire', source });
  firingInProgress = true;
  fire().finally(() => { firingInProgress = false; });
}

// --- Audio triggers -------------------------------------------------
// A spoken phrase ("hey Kydo") shows a canned reply immediately, bypassing the LLM.
const TRIGGER_HOLD_MS = 12_000;       // replies are short — don't linger like a question
const TRIGGER_COOLDOWN_MS = 15_000;   // don't re-fire the same trigger from overlapping chunks
const lastTriggerAt = {};

function fireTrigger(trigger) {
  const now = Date.now();
  if (lastTriggerAt[trigger.id] && now - lastTriggerAt[trigger.id] < TRIGGER_COOLDOWN_MS) return;
  if (killed || firingInProgress || ui.getPhase() !== 'listening') return;
  lastTriggerAt[trigger.id] = now;
  logEvent({ type: 'trigger', id: trigger.id, response: trigger.response });
  fired += 1;
  lastQuestionText = trigger.response;
  firingInProgress = true;
  ui.setStateLabel('typing');
  ui.showQuestion(trigger.response, TRIGGER_HOLD_MS, { kind: 'reply' }).finally(() => {
    firingInProgress = false; // showQuestion resets the state label to 'listening' on exit
    // Reset the auto-timer so a scheduled question doesn't immediately follow the reply.
    nextFireAt = Date.now() + CYCLE_SECONDS * 1000;
  });
}

window.addEventListener('keydown', (e) => {
  // Manual fire — Space and Cmd+Enter.
  const isFire =
    e.code === 'Space' ||
    ((e.metaKey || e.ctrlKey) && e.key === 'Enter');

  if (isFire) {
    e.preventDefault();
    e.stopPropagation();
    manualFire(e.code === 'Space' ? 'space' : 'cmd-enter');
  }

  if (e.key === 'p' || e.key === 'P') paused ? resumeTimer() : pauseTimer();
  if ((e.key === 'm' || e.key === 'M') && micState !== 'live') startMic();
});

let paused = false;
let pausedAt = 0;
function pauseTimer() { paused = true; pausedAt = Date.now(); }
function resumeTimer() { paused = false; nextFireAt += Date.now() - pausedAt; }

// --- Event log (in-memory; Phase 4 will persist) -------------------
const eventLog = [];
function logEvent(e) {
  eventLog.push({ t: Date.now(), ...e });
  if (eventLog.length > 500) eventLog.shift();
}
window.__kydo = {
  log: eventLog,
  transcript,
  mic,
  ui,
  generator,
  triggers: TRIGGERS,
  // Test a trigger without speaking: __kydo.testTrigger('hey kydo')
  testTrigger: (text) => {
    const t = matchTrigger(text);
    if (t) fireTrigger(t);
    return t ? t.id : null;
  },
  // Tuning helper: prints recent chunk levels (silence vs speech) so you can set
  // SILENCE_GATE_AVG in src/audio.js. Stay quiet for a few seconds, then talk, then run it.
  levels: () => {
    const ls = eventLog.filter((e) => e.type === 'level').slice(-20);
    const silent = ls.filter((e) => !e.sent).map((e) => e.avg);
    const sent = ls.filter((e) => e.sent).map((e) => e.avg);
    const stat = (a) => (a.length ? `min ${Math.min(...a)} · max ${Math.max(...a)} · n ${a.length}` : 'none');
    console.log('[kydo] gated (silence) avg:', stat(silent));
    console.log('[kydo] sent (speech)   avg:', stat(sent));
    console.table(ls.map((e) => ({ sent: e.sent, avg: e.avg, peak: e.peak })));
    return ls;
  },
};

console.log(
  '%cKydo',
  'font: 14px ui-monospace; color: #C7D1FF; padding: 4px 0;',
  `\n  cycle: ${CYCLE_SECONDS}s · hold: ${HOLD_SECONDS}s · vault: ${vault.length} entries · triggers: ${TRIGGERS.length} · mic: ${NO_MIC ? 'disabled' : 'click to start'}` +
    '\n  SPACE / Cmd+Enter = fire now · P = pause/resume · M = start mic' +
    '\n  ?fast = dev timing · ?debug = overlay · ?nomic = skip mic' +
    '\n  __kydo.log = event log · __kydo.testTrigger("hey kydo") = test a trigger'
);

function formatSeconds(s) {
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const r = total % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

if (!NO_MIC) ui.showStartGate();
