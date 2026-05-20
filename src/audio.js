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
        autoGainControl: true,
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
      this._emit(this.chunkHandlers, blob);
      if (blob.size > 0) {
        this._transcribe(blob);
      }
      if (this.running) {
        // small gap before next cycle so we don't tail-bite ourselves
        this.recorderTimer = setTimeout(() => this._beginRecorderCycle(), RESTART_GAP_MS);
      }
    });

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
