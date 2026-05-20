# Kydo

A bot that listens to a live conversation and serves contextual questions on a dedicated screen.

Built for the Pablo Honey × Robert Hodgin fireside chat at Automattic's Noho Space, May 21 2026.

The name and lineage come from a project Pablo co-created for Ars Electronica — a critic-bot that absorbed the cultural zeitgeist on Twitter and posted commentary back into the festival. New Kydo is the same idea, narrowed to one room: it listens to the chat, learns the temperature, fires one provocative line every five minutes onto an audience screen. The line vanishes after a minute. A breathing K and a live waveform fill the space between.

See `PLAN.md` for the full build spec.

## Status

- **Phase 1 ✓** — visible Kydo: listening animation, question card, vault timer.
- **Phase 2 ✓** — chunked Whisper transcription via Express proxy; mic-driven waveform.
- **Phase 3 ✓** — Anthropic two-pass generation: Sonnet generator + Haiku judge; client-side filter; topic cooldown (20 min); mid-sentence guard.
- **Phase 4 ✓** — rehearsal mode with inline vault editor at `/rehearse.html`, phone remote at `/control.html`, one-command launcher.

## Run

```bash
npm install
npm start          # runs API proxy (:5175) + Vite display (:5174) together
```

Or run them in separate terminals if you want to see logs split:

```bash
npm run server     # Express proxy on :5175
npm run dev        # Vite display on :5174
```

Open `http://localhost:5174` on the screen laptop. Fullscreen: `Cmd+Ctrl+F` (Safari) or `F11` / `Cmd+Shift+F` (Chrome).

### URLs

| URL                              | Purpose                                                 |
|----------------------------------|---------------------------------------------------------|
| `http://localhost:5174/`         | **Display** — fullscreen, audience-facing               |
| `http://localhost:5174/rehearse.html` | **Rehearsal** — pre-event vault tuning + dry runs   |
| `http://<lan-ip>:5174/control.html`   | **Phone remote** — open from your phone on same WiFi |

To find your LAN IP for the phone remote: `ipconfig getifaddr en0` on macOS.

## API keys

Copy `.env.example` → `.env.local` and fill in:

```
ANTHROPIC_API_KEY=...    # for question generation
OPENAI_API_KEY=...       # for Whisper transcription
KYDO_GENERATOR_MODEL=claude-sonnet-4-5   # optional override
KYDO_JUDGE_MODEL=claude-haiku-4-5        # optional override
```

Without keys, Kydo still runs: transcription is skipped, generation falls back to the vault on a timer. Every failure mode degrades to a working state — the screen never shows an error.

## Dev shortcuts

URL params:
- `?fast` — 20s cycle / 8s hold instead of 5 min / 60s. Use during build/test.
- `?debug` — show the debug overlay (phase, next-in, fired count, mic state, buffer span, last transcript).
- `?nomic` — skip the mic and start gate entirely; runs from vault on timer.

Keyboard (display window must be focused):
- `Space` or `Cmd+Enter` — fire a question immediately (manual fire bypasses the mid-sentence guard).
- `P` — pause / resume the timer.
- `M` — start/retry mic.

Browser console:
- `__kydo.log` — in-memory event log (transcripts, generations, judge decisions, fires, triggers).
- `__kydo.transcript.getRecent()` — current rolling transcript window (4 minutes).
- `__kydo.testTrigger("hey kydo")` — fire a trigger reply without speaking.

## Architecture

```
┌──────────────────────┐   ┌──────────────────────────┐
│  Display (Vite)      │   │  Backend (Express :5175) │
│  :5174               │   │                          │
│  ─ index.html        │   │  /api/health             │
│  ─ src/main.js       │   │  /api/transcribe ──────► │── OpenAI Whisper
│  ─ src/audio.js      │   │  /api/generate ────────► │── Anthropic Sonnet
│  ─ src/transcript.js │   │    └─ judge pass ──────► │── Anthropic Haiku
│  ─ src/generator.js  │   │                          │
│  ─ src/filters.js    │   │  prompt.js (server-side) │
│  ─ src/ui.js         │   │                          │
│  ─ src/vault.json    │   └──────────────────────────┘
│  ─ src/styles.css    │
└──────────────────────┘
       ▲       │
       │       │ mic
       │       ▼
   audience  laptop on table
```

Vite proxies `/api` to the Express server. Both run locally on the display laptop.

## Anti-slop architecture (Phase 3)

Every fire goes through five gates:

1. **Topic cooldown** — recently-fired noun keywords are passed to the model as a "don't touch" list, refreshed on a 20-min window.
2. **System prompt** — anchors the persona, hard rules, banned-phrase list, and 24 exemplars from the vault.
3. **Generator (Sonnet)** — writes one candidate line, max 80 tokens.
4. **Judge (Haiku)** — strict editor pass. Outputs `PASS` or `REJECT: <reason>`.
5. **Local filter** — deterministic check: word count, banned phrases, speaker names, softeners, compliments, "How" opener.

On reject, retry up to 2× more. On 3 fails or 503, fall back to the vault. Every step is logged.

## The vault

`src/vault.json` holds 24 placeholder questions in Kydo's voice. Two roles:

- **Exemplars**: included in the generator's system prompt as voice anchors.
- **Fallback**: served on a timer when generation fails (no API key, network down, all retries rejected).

Replace these with seeds Pablo has personally approved before the event.

## Rehearsal workflow

Open `http://localhost:5174/rehearse.html` before the event.

1. Paste a chunk of what you expect Robert to say into the transcript box (or type as you read your prep aloud).
2. Click **Generate candidate**. The candidate appears with `LLM` / judge / filter pills showing what passed.
3. **Accept** adds the candidate to the vault. **Reject** drops it (history keeps both, for review).
4. Edit any existing vault line inline. **Save vault** commits to `src/vault.json` on disk.
5. The next live run picks up the updated vault automatically.

`Cmd/Ctrl+Enter` generates; `Cmd/Ctrl+S` saves the vault.

## Phone remote

Open `/control.html` on your phone over LAN. Big-target buttons:

- **Fire now** — manual fire, overrides the 5-min timer (bypasses the mid-sentence guard — a manual press fires immediately).
- **Skip current** — dismiss the on-screen question and reset the cycle.
- **Pause 5 min** — push the next fire back by 5 minutes.
- **Resume** — undo a pause.
- **Kill** — stop all firing until you Revive.

State (phase, time to next, mic, fired count, last question) refreshes every 1.5s.

## Audio triggers

Spoken phrases that make Kydo respond instantly with a canned line, bypassing the LLM. Defined in `src/triggers.js`:

| You say | Kydo shows (`$reply = "…"`) |
|---|---|
| "hi Kydo" | hi there, how are you doing over there in atoms? |
| "hey Kydo" | What's up? |

- Detection latency is ~2.5–3.5s (2.5s audio chunks + Whisper round-trip). This is decoupled from question generation, which draws on a wider 4-minute window for context.
- Matching is generous about Whisper mishearing "Kydo" (kaido, kiddo, kyoto, keto…) and spans the chunk boundary so a greeting split across it still fires.
- 15s per-trigger cooldown; won't interrupt an in-progress question; respects Kill.
- Add more: append `{ id, pattern: greeting('word'), response: '…' }` to `TRIGGERS` in `src/triggers.js`.

## Files

```
PLAN.md
package.json
vite.config.js
server.js                 Express proxy (transcribe, generate, vault, state, control)
prompt.js                 system prompt + judge prompt (server-side)
index.html                display (fullscreen)
rehearse.html             pre-event rehearsal + vault editor
control.html              phone remote
src/
  main.js                 display state machine, scheduler, triggers, remote integration
  ui.js                   UI controller (states, typewriter, start gate, debug overlay)
  audio.js                mic capture + chunked Whisper POST (2.5s chunks)
  transcript.js           rolling 4-minute buffer
  generator.js            client-side generation coordinator
  filters.js              local rule-based check
  whisper-filter.js       strips Whisper hallucinations from transcript chunks
  triggers.js             spoken-phrase triggers ("hey Kydo" → canned reply)
  vault.json              exemplars + fallback questions
  styles.css              display: dark, Roboto Mono, breathing K, mic-driven wave
  rehearse.js / .css      rehearsal page
  control.js  / .css      phone remote
logs/                     (gitignored) reserved for future event logs
```
