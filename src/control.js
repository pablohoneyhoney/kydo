// Kydo — phone remote.
// Polls /api/state every 1.5s for display status; POSTs /api/control on tap.

const $ = (s) => document.querySelector(s);
const statusDot = $('#status-dot');
const statusText = $('#status-text');
const sPhase = $('#s-phase');
const sNext = $('#s-next');
const sMic = $('#s-mic');
const sFired = $('#s-fired');
const sPaused = $('#s-paused');
const sLast = $('#s-last');
const reviveBtn = $('#revive-btn');
const cmdFeedback = $('#cmd-feedback');

let lastUpdate = 0;
let killed = false;

function formatSeconds(s) {
  const total = Math.max(0, Math.round(s));
  const m = Math.floor(total / 60);
  const r = total % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}

async function poll() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) throw new Error('not ok');
    const s = await r.json();
    const d = s.display || {};
    const fresh = d.updatedAt && (Date.now() - d.updatedAt) < 5000;
    lastUpdate = d.updatedAt;

    statusDot.classList.remove('ok', 'warn', 'bad');
    if (fresh) {
      statusDot.classList.add('ok');
      statusText.textContent = `live · ${Math.round((Date.now() - d.updatedAt) / 1000)}s`;
    } else if (d.updatedAt) {
      statusDot.classList.add('warn');
      statusText.textContent = `stale · ${Math.round((Date.now() - d.updatedAt) / 1000)}s`;
    } else {
      statusDot.classList.add('bad');
      statusText.textContent = 'no display';
    }

    sPhase.textContent = d.phase || '—';
    sNext.textContent = formatSeconds(d.nextInSeconds || 0);
    sMic.textContent = d.micState || '—';
    sFired.textContent = String(d.fired ?? 0);
    sPaused.textContent = d.paused ? 'yes' : 'no';
    sLast.textContent = d.lastQuestion || '—';

    killed = d.killed === true;
    reviveBtn.hidden = !killed;
  } catch {
    statusDot.classList.remove('ok', 'warn');
    statusDot.classList.add('bad');
    statusText.textContent = 'backend offline';
  }
}

async function command(action) {
  cmdFeedback.textContent = `sending ${action}…`;
  try {
    const r = await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      cmdFeedback.textContent = `failed: ${j.error || r.statusText}`;
      return;
    }
    cmdFeedback.textContent = `${action} sent`;
    // Strong haptic on phones that support it
    if (navigator.vibrate) navigator.vibrate(action === 'kill' ? [25, 25, 25] : 15);
    setTimeout(() => { cmdFeedback.textContent = ''; }, 2000);
  } catch (e) {
    cmdFeedback.textContent = `error: ${e.message}`;
  }
}

document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const action = e.currentTarget.dataset.action;
    if (action === 'kill') {
      if (!confirm('Kill Kydo? No more questions until you revive.')) return;
    }
    command(action);
  });
});

poll();
setInterval(poll, 1500);
