# Kydo — Build Plan

A bot that runs on a dedicated screen during the Pablo × Robert Hodgin fireside chat. It listens to the live conversation through a laptop mic, and every 5 minutes serves a contextual question to the audience screen. Question persists 1 minute, then fades to an animated listening state.

This is a new project at `~/Documents/claude/kydo/`, registered in `.claude/launch.json`.

---

## Decisions locked

| Decision | Choice |
|---|---|
| Generation | Pure LLM live (with hardened anti-slop discipline) |
| Audio source | Laptop on the table, built-in mic |
| Display | Dedicated screen visible to audience |
| Control | Pre-show rehearsal, autonomous during the talk |
| No Spanish in Kydo's output | Confirmed (carries from chat constraints) |

---

## Stack

- **Frontend**: Vite + vanilla JS/CSS. No framework — two visual states, managed in CSS. Fullscreen.
- **Audio + transcription**: OpenAI Realtime API via browser WebSocket. Built-in mic via `getUserMedia`. ~300ms latency, partial results.
- **LLM**: Anthropic API, Claude Sonnet 4.7 for question generation; Claude Haiku 4.5 for the slop-filter judge pass. ~1s end-to-end every 5 min.
- **Backend proxy**: Tiny Express server (`server.js`) on localhost. Holds API keys, proxies Realtime + Anthropic. Browser only talks to localhost.
- **Persistence**: Local JSON files — `logs/transcript-{timestamp}.jsonl`, `logs/questions-{timestamp}.jsonl`. Reviewable post-event.
- **Control surface**: `/control` route opens on Pablo's phone via local IP. Buttons: skip / pause 5 min / kill / manual fire.

---

## Visual design (placeholder; refined once original Kydo brief is shared)

- **Listening state**: a slow-breathing typographic form for "K," with a subtle waveform underneath driven by mic amplitude. Dark background. Generous letter-spacing.
- **Question state**: question fades in over 800ms, holds 60s, fades out 1s. Large serif or mono. One question per card. No prefixes, no attribution to Kydo, no "asks:" framing — the question stands alone.
- **Color palette**: near-black background, off-white type, one accent. Tuned in rehearsal so the screen reads from the back of the room without competing for attention.

---

## The anti-slop architecture (the actual engineering problem)

Pure-LLM live is the most slop-prone configuration. The defenses are:

### 1. The system prompt is Kydo's whole personality

Anchored by:
- **Original Kydo's character brief** — Pablo to provide.
- **A vault of 10–15 exemplar questions** written by Pablo (or drafted by Claude, triaged by Pablo) in Kydo's voice. These are the north star, not the questions Kydo asks — Kydo never repeats them verbatim.
- **Hard rules**: max 18 words; no softeners ("I wonder if…", "Don't you think…"); never start with "How"; never address speakers by name; never compliment; never resolve a paradox; questions may end as statements, not always with "?"; never parrot a phrase the speakers just used.
- **Anti-pattern phrase list** (~8 banned phrases): "in the age of AI", "real art", "the human touch", "thought-provoking", "deeper meaning", "creative process", "at the end of the day", etc.

### 2. Two-pass generation with a judge

- **Pass 1 (Sonnet)**: Generate one candidate question from last 90s of transcript + system prompt.
- **Pass 2 (Haiku)**: Judge it against the rules. Pass / fail with one-line reason.
- On fail: regenerate up to 2 more times.
- After 3 failures: serve a hardcoded vault entry instead.

### 3. Context window discipline

- Send only the **last 90s** of transcript, not the rolling 5 min. Keeps Kydo responsive to the moment, not stuck on a topic Robert moved off of.
- Track topics fired in the last 20 min; force the model to avoid them.

### 4. Pre-show rehearsal mode

- Run Kydo against a simulated transcript (Pablo reads aloud from prep, or we replay a previous talk).
- Pablo approves/rejects each generated question in a side panel.
- Approved questions get added to the **exemplar vault** feeding the system prompt — Kydo learns Pablo's taste during rehearsal.
- Rejection reasons get added to the anti-pattern list.
- Vault grows from ~15 seeds to ~40–50 by the time doors open.

---

## Failure ladder (graceful degradation)

1. Internet + transcription healthy → pure LLM generation.
2. Transcription stalls > 30s → fall back to vault on a 5-min timer.
3. LLM call fails or judge rejects 3× → fall back to vault.
4. Audio device fails → display goes to a "thinking" state, vault on timer.
5. Pablo hits kill on phone → blank screen, listening animation only, no questions until resumed.

In every case, the screen stays composed — never an error message, never a flash of broken UI.

---

## Mid-sentence guard

Before firing a question, check the last 8 seconds of transcript:
- If there's speech in progress (no terminal silence > 1.2s), defer the question by up to 30 seconds, waiting for a natural pause.
- After 30s of failed waiting, fire anyway — but log the violation for post-event review.

---

## File layout

```
kydo/
├── PLAN.md                  (this file)
├── package.json
├── vite.config.js
├── server.js                (Express proxy, dotenv)
├── .env.local               (API keys — gitignored)
├── index.html               (display)
├── control.html             (phone remote)
├── src/
│   ├── main.js              (display entry, state machine)
│   ├── audio.js             (getUserMedia + Realtime WS)
│   ├── transcript.js        (rolling buffer)
│   ├── generator.js         (Anthropic two-pass)
│   ├── prompt.js            (system prompt assembly)
│   ├── vault.json           (exemplars + fallbacks)
│   ├── filters.js           (anti-pattern checks)
│   ├── ui.js                (state machine, transitions)
│   └── styles.css
├── logs/                    (gitignored)
│   └── .gitkeep
└── README.md
```

---

## Build phases

**Phase 1 — visible Kydo (Day 1 morning, ~3h)**
- Scaffold Vite + Express, register in `.claude/launch.json`
- Fullscreen layout, listening animation, question card animation
- Vault JSON, hardcoded 5-min timer that rotates through vault
- End state: a working "fake" Kydo, ready to be on stage if everything else fails

**Phase 2 — listening Kydo (Day 1 afternoon, ~3h)**
- `getUserMedia` mic capture, Realtime API WebSocket, rolling transcript buffer
- Transcript visible in `/control` for sanity-checking
- Audio amplitude → listening-state waveform animation
- End state: Kydo can see, but still talks from vault

**Phase 3 — thinking Kydo (Day 2 morning, ~3h)**
- Anthropic generator with system prompt + 15 seed exemplars
- Haiku judge pass, regeneration on fail, vault fallback
- Topic cooldown, mid-sentence guard
- End state: Kydo generates live, fully

**Phase 4 — rehearsal + polish (Day 2 afternoon, ~3h)**
- Rehearsal mode: side panel where Pablo approves/rejects candidates
- `/control` phone surface (skip / pause / kill / manual fire)
- Local-network IP exposed for phone access
- Dry run against simulated transcript
- Polish animations, type, timing
- README

**Total**: ~12 focused hours of work. 1.5–2 calendar days.

---

## Open inputs needed from Pablo

1. **Original Kydo** — what it did, looked like, sounded like, why it mattered. The Ars Electronica PDF wouldn't fetch via web tools.
2. **Event date and time** — so we know if the build window fits.
3. **API keys** in `.env.local`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (for Realtime). Pablo provisions; not asked for here.
4. **Vault seed** — 5–10 example questions in Kydo's voice. Pablo can draft, or Claude can draft from the original Kydo brief for Pablo to triage.

---

## Out of scope

- No livestream / OBS integration. HDMI to the screen.
- No transcript publication. Local logs only, deletable after.
- No persistent state between events. Fresh start every run.
- No public hosting. Localhost only.
- No moderation by an offstage person. Pablo is the only operator.

---

## What success looks like

The audience notices Kydo three times during the hour, talks about it for a week afterward, and at no point does a question land as cringe. Robert reads one of Kydo's questions on screen and laughs. Matt asks what stack it's built on. The transcript log shows we fired 10–12 questions; the post-event review shows 8+ of them landed.
