// Kydo — mic capture + chunked transcription.
//
// What this does:
//   1. Requests mic permission (must be triggered by a user gesture)
//   2. Runs an AnalyserNode loop for amplitude → wave UI
//   3. Records 6-second audio blobs via MediaRecorder (stop/start cycle)
//   4. POSTs each blob to /api/transcribe and emits the returned text
//
// Why chunked Whisper instead of Realtime API:
//   - 5-min question cadence makes sub-second latency unnecessary
//   - One HTTP call per chunk is more robust than a persistent WebSocket
//   - Cheaper, and easier to degrade gracefully on network blips

// Short chunks = fast trigger detection ("hey Kydo" lands in ~2.5-3.5s).
// This only affects transcription LATENCY/granularity, not how much context the
// question generator sees — that's the buffer window in main.js, set independently.
// Cost is billed by audio duration, so more-but-shorter requests cost the same.
const CHUNK_MS = 2500;
const RESTART_GAP_MS = 60; // small gap between MediaRecorder cycles; acceptable for our use

// Silence gate: if a chunk's AVERAGE mic amplitude (raw, 0..1) stays below this, the
// chunk is NOT sent to Whisper, so it can't hallucinate on near-silence. Average (not
// peak) is used so a single transient — a click, a chair creak — doesn't open the gate.
// With AGC off + noise suppression on, true silence sits very low and speech clears it
// easily. Tune at the venue by watching __kydo.log chunk levels (see main.js).
const SILENCE_GATE_AVG = 0.012;

export class Mic {
  constructor() {
    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.dataArray = null;
    this.recorder = null;
    this.recorderTimer = null;
    this.chunkHandlers = new Set();
    this.amplitudeHandlers = new Set();
    this.transcriptHandlers = new Set();
    this.errorHandlers = new Set();
    this.running = false;
    this.mimeType = pickMimeType();
    this.chunkPeak = 0;  // peak amplitude within the current recording chunk
    this.chunkSum = 0;   // running sum of per-frame amplitude (for the average gate)
    this.chunkCount = 0; // number of frames summed this chunk
  }

  isSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  async start() {
    if (!this.isSupported()) {
      throw new Error('mic-unsupported');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        // CRITICAL: AGC off. With it on, the mic boosts its gain in a quiet room until
        // the noise floor reads as loud — silent chunks then pass the gate and Whisper
        // hallucinates credits/sign-offs on them. Off = amplitude reflects real input.
        autoGainControl: false,
        sampleRate: 16000,
      },
    });

    // Amplitude analyser (independent of recorder, so the wave keeps moving even mid-flush)
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.6;
    source.connect(this.analyser);
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    this.running = true;
    this._beginRecorderCycle();
    this._beginAmplitudeLoop();
  }

  stop() {
    this.running = false;
    if (this.recorderTimer) clearTimeout(this.recorderTimer);
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch {}
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  onChunk(handler) { this.chunkHandlers.add(handler); }
  onAmplitude(handler) { this.amplitudeHandlers.add(handler); }
  onTranscript(handler) { this.transcriptHandlers.add(handler); }
  onError(handler) { this.errorHandlers.add(handler); }

  _emit(set, ...args) {
    set.forEach((h) => {
      try { h(...args); } catch (e) { console.error('handler threw', e); }
    });
  }

  _beginAmplitudeLoop() {
    const tick = () => {
      if (!this.running || !this.analyser) return;
      this.analyser.getByteFrequencyData(this.dataArray);
      // RMS-ish single-number summary, normalized 0..1.
      let sum = 0;
      for (let i = 0; i < this.dataArray.length; i++) sum += this.dataArray[i];
      const avg = sum / this.dataArray.length / 255;
      if (avg > this.chunkPeak) this.chunkPeak = avg; // peak (info only)
      this.chunkSum += avg;                            // for the average-based gate
      this.chunkCount += 1;
      this._emit(this.amplitudeHandlers, avg);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _beginRecorderCycle() {
    if (!this.running || !this.stream) return;

    let chunks = [];
    try {
      this.recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
    } catch (e) {
      // Fall back to default mime
      this.recorder = new MediaRecorder(this.stream);
    }

    this.recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });

    this.recorder.addEventListener('stop', async () => {
      const blob = new Blob(chunks, { type: this.recorder.mimeType || this.mimeType });
      chunks = [];
      const peak = this.chunkPeak;
      const avg = this.chunkCount > 0 ? this.chunkSum / this.chunkCount : 0;
      const sent = blob.size > 0 && avg >= SILENCE_GATE_AVG;
      this._emit(this.chunkHandlers, blob);
      // Always report levels so the gate threshold can be tuned at the venue.
      this._emit(this.errorHandlers, {
        stage: sent ? 'chunk-sent' : 'gated-silent',
        avg: Number(avg.toFixed(4)),
        peak: Number(peak.toFixed(4)),
        gate: SILENCE_GATE_AVG,
      });
      if (sent) {
        this._transcribe(blob);
      }
      if (this.running) {
        // small gap before next cycle so we don't tail-bite ourselves
        this.recorderTimer = setTimeout(() => this._beginRecorderCycle(), RESTART_GAP_MS);
      }
    });

    // reset per-chunk amplitude accumulators
    this.chunkPeak = 0;
    this.chunkSum = 0;
    this.chunkCount = 0;
    this.recorder.start();

    this.recorderTimer = setTimeout(() => {
      if (this.recorder && this.recorder.state === 'recording') {
        this.recorder.stop();
      }
    }, CHUNK_MS);
  }

  async _transcribe(blob) {
    try {
      const fd = new FormData();
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
      fd.append('audio', blob, `chunk.${ext}`);
      const r = await fetch('/api/transcribe', { method: 'POST', body: fd });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        this._emit(this.errorHandlers, {
          stage: 'transcribe',
          status: r.status,
          detail,
        });
        return;
      }
      const { text } = await r.json();
      if (text && text.trim()) {
        this._emit(this.transcriptHandlers, text.trim());
      }
    } catch (e) {
      this._emit(this.errorHandlers, { stage: 'transcribe', error: String(e?.message || e) });
    }
  }
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'audio/webm';
}
