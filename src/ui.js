// Kydo — UI state machine + start gate + debug overlay.

export function setupUI({ debug = false } = {}) {
  const stage = document.getElementById('stage');
  const qText = document.getElementById('question-text');
  const qHead = document.querySelector('.question-head');
  const qFoot = document.querySelector('.question-foot');
  const markEl = document.querySelector('.mark');           // the $state value
  const kwEl = document.getElementById('state-keywords');   // live keyword ticker
  const dbgEl = document.getElementById('debug');
  const dbgPhase = document.getElementById('dbg-phase');
  const dbgNext = document.getElementById('dbg-next');
  const dbgFired = document.getElementById('dbg-fired');
  const dbgMic = document.getElementById('dbg-mic');
  const dbgBuf = document.getElementById('dbg-buf');
  const dbgTx = document.getElementById('dbg-tx');
  const gate = document.getElementById('start-gate');
  const gateBtn = document.getElementById('start-button');
  const gateMsg = document.getElementById('start-message');

  if (debug && dbgEl) dbgEl.hidden = false;

  let phase = 'listening';
  let startHandlers = [];
  let recentTranscript = [];

  function setPhase(next) {
    phase = next;
    stage.classList.remove('state-listening', 'state-question');
    stage.classList.add(`state-${next}`);
  }

  function getPhase() { return phase; }

  // Swap the terminal frame around the line.
  //   'question' →  $question = [ ... ];
  //   'reply'    →  $reply = " ... ";
  function applyFrame(kind) {
    if (!qHead || !qFoot) return;
    if (kind === 'reply') {
      qHead.innerHTML = '<span class="syntax">$</span><span class="var">reply</span><span class="syntax"> = "</span>';
      qFoot.innerHTML = '<span class="syntax">";</span>';
    } else {
      qHead.innerHTML = '<span class="syntax">$</span><span class="var">question</span><span class="syntax"> = [</span>';
      qFoot.innerHTML = '<span class="syntax">];</span>';
    }
  }

  async function showQuestion(text, holdMs, opts = {}) {
    applyFrame(opts.kind || 'question');

    // Reset text for the typewriter
    qText.textContent = '';
    qText.classList.add('typing');
    await new Promise((r) => requestAnimationFrame(r));
    setPhase('question');

    // Type the line out, terminal-style. Variable pacing on punctuation
    // for natural rhythm — too steady reads as robotic.
    const typingMs = await typewriter(qText, text);
    qText.classList.remove('typing');

    // Hold for the rest of the configured time, minus what typing already consumed.
    const remaining = Math.max(500, holdMs - typingMs);
    await wait(remaining);

    // Erase the line in reverse — like deleting it — instead of a plain fade.
    qText.classList.add('erasing');
    await eraseTypewriter(qText);
    qText.classList.remove('erasing');

    setPhase('listening');
    setStateLabel('listening'); // back to idle exactly as the listening view returns
    await wait(400);
  }

  // Reverse typewriter: remove characters from the end, faster than typing.
  async function eraseTypewriter(el) {
    const chars = [...el.textContent];
    for (let i = chars.length - 1; i >= 0; i--) {
      el.textContent = chars.slice(0, i).join('');
      await wait(16);
    }
  }

  // The $state value: 'listening' (idle) or 'typing' (composing a line).
  function setStateLabel(text) {
    if (markEl) markEl.textContent = text;
  }

  // Single live keyword after "listening_". Re-renders (and re-fades) only when the
  // word actually changes, so it doesn't flicker on every transcript chunk.
  function setKeyword(word) {
    if (!kwEl) return;
    if (!word) { kwEl.innerHTML = ''; kwEl.dataset.kw = ''; return; }
    if (kwEl.dataset.kw === word) return;
    kwEl.dataset.kw = word;
    kwEl.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'kw';
    span.textContent = word;
    kwEl.appendChild(span);
  }

  async function typewriter(el, text) {
    const start = Date.now();
    const chars = [...text]; // unicode-safe iteration
    let buffer = '';
    for (const c of chars) {
      buffer += c;
      el.textContent = buffer;
      // Pacing: punctuation pauses longer; spaces faster; everything else steady.
      let delay;
      if (c === '.' || c === '?' || c === '!') delay = 360;
      else if (c === ',' || c === ';' || c === ':') delay = 180;
      else if (c === ' ') delay = 32;
      else delay = 55;
      await wait(delay);
    }
    return Date.now() - start;
  }

  function setDebug({ phase, next, fired, micState, bufferSpan }) {
    if (!debug) return;
    if (dbgPhase) dbgPhase.textContent = phase;
    if (dbgNext) dbgNext.textContent = next;
    if (dbgFired) dbgFired.textContent = String(fired);
    if (dbgMic) dbgMic.textContent = micState ?? '—';
    if (dbgBuf) dbgBuf.textContent = bufferSpan ?? '—';
  }

  function appendTranscript(text) {
    recentTranscript.push(text);
    if (recentTranscript.length > 6) recentTranscript.shift();
    if (dbgTx) dbgTx.textContent = recentTranscript.join(' · ');
  }

  // --- Start gate (mic permission) ---
  function showStartGate() {
    if (gate) gate.hidden = false;
  }
  function hideStartGate() {
    if (gate) gate.hidden = true;
  }
  function onStart(handler) {
    startHandlers.push(handler);
  }
  function showStartError(msg) {
    if (gateMsg) gateMsg.textContent = `mic failed — ${msg}. press M to retry.`;
  }
  if (gateBtn) {
    gateBtn.addEventListener('click', () => {
      startHandlers.forEach((h) => h());
    });
  }

  return {
    showQuestion,
    getPhase,
    setPhase,
    setDebug,
    appendTranscript,
    setStateLabel,
    setKeyword,
    showStartGate,
    hideStartGate,
    showStartError,
    onStart,
  };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
