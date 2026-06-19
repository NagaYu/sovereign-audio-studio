/*
 * Sovereign Audio Studio — Local Audio AI Core (main thread)
 * ==========================================================
 * Orchestrates the entire local pipeline:
 *   1. Ingest media (drag&drop / picker) — MP3 / WAV / M4A / MP4 / WEBM ...
 *   2. Decode to PCM via Web Audio API.
 *   3. "AI Noise Reduction" — an offline Web Audio graph (high-pass + low-pass
 *      + dynamics) followed by an adaptive spectral noise gate, all on-device.
 *   4. Render a live waveform (Canvas) synced to playback.
 *   5. Resample to 16 kHz mono and hand off to a Web Worker running Whisper
 *      (WebGPU / WASM) for timestamped multilingual transcription.
 *   6. Track ROI: how much cloud spend was avoided ($0.00 actually spent).
 *
 * Not a single byte of audio leaves the device.
 */

"use strict";

const APP_VERSION = "1.2.4"; // bump to invalidate cached worker on deploy
const CLOUD_RATE_PER_MIN = 0.006; // OpenAI Whisper API reference: $0.006 / min

// ---------------------------------------------------------------------------
// Long-file safety limits (prevent the browser tab from running out of memory)
// ---------------------------------------------------------------------------
// A decoded hour of 48 kHz stereo PCM is ~1.4 GB; multiple full-length copies
// (decode → denoise → WAV) can OOM a tab. These guards keep memory bounded:
const MAX_DURATION_SEC = 90 * 60; // hard ceiling — refuse longer inputs
const AI_DENOISE_MAX_SEC = 15 * 60; // DeepFilterNet runs at 48 kHz → cap its length
const LONG_FILE_SEC = 5 * 60; // beyond this, down-mix to mono to halve memory

const state = {
  fileName: null,
  audioBuffer: null, // decoded original (AudioBuffer)
  cleanedBuffer: null, // denoised (AudioBuffer)
  cleanedWavUrl: null,
  durationSec: 0,
  backend: "—",
  model: "—",
  worker: null,
  workerReady: false,
  busy: false,
  peaks: null, // precomputed waveform peaks
  rafId: null,
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const dom = {};
function bindDom() {
  [
    "drop-zone", "file-input", "browse-btn", "stage", "filename", "filemeta",
    "waveform", "noise-slider", "noise-val", "lang-select", "process-btn",
    "progress-wrap", "progress-bar", "progress-label", "audio-player",
    "transcript", "copy-btn", "txt-btn", "srt-btn", "backend-pill",
    "roi-saved", "roi-time", "roi-words", "status-dot", "status-text",
    "play-btn", "reset-btn", "wpm", "demo-btn", "model-select", "model-hint",
    "ai-denoise", "ai-state", "noise-label",
  ].forEach((k) => (dom[k] = $(k)));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  const base = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${base}` : base + `.${String(ms).padStart(3, "0")}`;
}
function srtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    s
  ).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
function setStatus(text, kind = "idle") {
  dom["status-text"].textContent = text;
  dom["status-dot"].className = `status-dot ${kind}`;
}

// ---------------------------------------------------------------------------
// Ingest + decode
// ---------------------------------------------------------------------------
async function loadFile(file) {
  if (!file) return;
  if (state.busy) return;
  resetOutputs();

  state.fileName = file.name;
  setStatus("Decoding audio…", "work");
  dom["filename"].textContent = file.name;
  dom["filemeta"].textContent = `${fmtBytes(file.size)} · decoding…`;
  dom["stage"].classList.add("active");

  try {
    const arrayBuf = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
    ctx.close();

    if (audioBuffer.duration > MAX_DURATION_SEC) {
      setStatus("File too long", "err");
      dom["filemeta"].textContent =
        `⚠ ${fmtTime(audioBuffer.duration)} exceeds the ${MAX_DURATION_SEC / 60}-minute limit. ` +
        `Please split the file first.`;
      dom["process-btn"].disabled = true;
      return;
    }

    state.audioBuffer = audioBuffer;
    state.durationSec = audioBuffer.duration;

    dom["filemeta"].textContent =
      `${fmtBytes(file.size)} · ${fmtTime(audioBuffer.duration)} · ` +
      `${audioBuffer.sampleRate.toLocaleString()} Hz · ${audioBuffer.numberOfChannels}ch`;

    state.peaks = computePeaks(audioBuffer, 1400);
    drawWaveform(0);
    updateROI();
    dom["process-btn"].disabled = false;
    setStatus("Ready to process", "idle");
  } catch (err) {
    console.error(err);
    setStatus("Decode failed — unsupported codec?", "err");
    dom["filemeta"].textContent = "⚠ Could not decode this file.";
  }
}

// ---------------------------------------------------------------------------
// One-click demo (bundled noisy clip → load → denoise → transcribe)
// ---------------------------------------------------------------------------
async function runDemo() {
  if (state.busy) return;
  dom["demo-btn"].disabled = true;
  const original = dom["demo-btn"].textContent;
  dom["demo-btn"].textContent = "Loading demo clip…";
  setStatus("Fetching bundled demo…", "work");
  try {
    const res = await fetch("/static/sample.wav");
    if (!res.ok) throw new Error("sample.wav not found (HTTP " + res.status + ")");
    const blob = await res.blob();
    const file = new File([blob], "sovereign-demo.wav", { type: "audio/wav" });
    await loadFile(file);
    if (state.audioBuffer) {
      // ensure the demo shows off the denoise + a meaningful transcription
      dom["demo-btn"].textContent = "Running on-device AI…";
      await process();
    }
  } catch (err) {
    console.error(err);
    setStatus("Demo failed: " + (err.message || err), "err");
  } finally {
    dom["demo-btn"].disabled = false;
    dom["demo-btn"].textContent = original;
  }
}

// ---------------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------------
function computePeaks(buffer, buckets) {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const step = Math.max(1, Math.floor(len / buckets));
  const peaks = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const start = b * step;
    let max = 0;
    for (let c = 0; c < ch; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < step && start + i < len; i += 1) {
        const v = Math.abs(data[start + i]);
        if (v > max) max = v;
      }
    }
    peaks[b] = max;
  }
  return peaks;
}

function drawWaveform(progress = 0) {
  const canvas = dom["waveform"];
  if (!canvas || !state.peaks) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const peaks = state.peaks;
  const n = peaks.length;
  const mid = h / 2;
  const barW = w / n;
  const playX = progress * w;

  for (let i = 0; i < n; i++) {
    const x = i * barW;
    const amp = Math.pow(peaks[i], 0.7) * (h * 0.46);
    const played = x <= playX;
    ctx.fillStyle = played ? "#28e0c8" : "rgba(120,140,170,0.45)";
    if (played) {
      ctx.shadowColor = "rgba(40,224,200,0.6)";
      ctx.shadowBlur = 6;
    } else {
      ctx.shadowBlur = 0;
    }
    ctx.fillRect(x, mid - amp, Math.max(1, barW * 0.7), amp * 2);
  }
  ctx.shadowBlur = 0;

  // playhead
  ctx.fillStyle = "#ff5d73";
  ctx.fillRect(playX - 1, 0, 2, h);
}

function startPlayheadLoop() {
  cancelAnimationFrame(state.rafId);
  const tick = () => {
    const a = dom["audio-player"];
    const dur = a.duration || state.durationSec || 1;
    drawWaveform((a.currentTime || 0) / dur);
    if (!a.paused && !a.ended) state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// AI Noise Reduction (Web Audio API + adaptive gate)
// ---------------------------------------------------------------------------
async function denoise(buffer, strength /* 0..1 */) {
  const sr = buffer.sampleRate;
  const off = new OfflineAudioContext(
    buffer.numberOfChannels,
    buffer.length,
    sr
  );
  const src = off.createBufferSource();
  src.buffer = buffer;

  // High-pass: strip low-frequency rumble / AC hum (stronger with strength)
  const hp = off.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 50 + strength * 170; // 50–220 Hz
  hp.Q.value = 0.707;

  // Low-pass: tame high-frequency hiss
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = Math.max(4000, 16000 - strength * 8500); // 16k → 7.5k
  lp.Q.value = 0.707;

  // Presence notch is skipped; a gentle compressor evens out levels.
  const comp = off.createDynamicsCompressor();
  comp.threshold.value = -28;
  comp.knee.value = 24;
  comp.ratio.value = 3;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;

  src.connect(hp);
  hp.connect(lp);
  lp.connect(comp);
  comp.connect(off.destination);
  src.start();

  const rendered = await off.startRendering();
  applyNoiseGate(rendered, strength);
  return rendered;
}

// ---------------------------------------------------------------------------
// DeepFilterNet3 — studio-grade neural speech enhancement (100% local)
// ---------------------------------------------------------------------------
// Self-hosted ONNX + Rust/WASM model served from /static/df3 (no third-party
// CDN at runtime → keeps the product sovereign). Runs inside an
// OfflineAudioContext via an AudioWorklet, so it processes a whole file faster
// than realtime without ever leaving the device.
const DF_LIB_URL = "/static/vendor/deepfilternet3.esm.js"; // self-hosted (no CDN)
let dfModulePromise = null;
function loadDFModule() {
  if (!dfModulePromise) dfModulePromise = import(DF_LIB_URL);
  return dfModulePromise;
}

async function denoiseAI(buffer, levelPercent) {
  const { DeepFilterNet3Core } = await loadDFModule();
  const sr = 48000; // DeepFilterNet3 operates at 48 kHz
  const tail = 0.5; // pad for the model's algorithmic latency so nothing is cut
  const length = Math.ceil((buffer.duration + tail) * sr);
  const ctx = new OfflineAudioContext(1, length, sr);

  const proc = new DeepFilterNet3Core({
    sampleRate: sr,
    noiseReductionLevel: Math.max(0, Math.min(100, Math.round(levelPercent))),
    assetConfig: { cdnUrl: `${location.origin}/static/df3` },
  });
  await proc.initialize(); // fetch + compile wasm + load ONNX model (cached)
  const node = await proc.createAudioWorkletNode(ctx);

  const src = ctx.createBufferSource();
  src.buffer = buffer; // BufferSource auto-resamples to the 48 kHz context
  src.connect(node);
  node.connect(ctx.destination);
  src.start();

  const rendered = await ctx.startRendering();
  try {
    proc.destroy && proc.destroy();
  } catch (_) {
    /* best effort */
  }
  return rendered;
}

/**
 * Adaptive downward-expander noise gate (time domain).
 *
 * Crucially, the threshold is placed *between* the estimated noise floor and the
 * estimated speech level — never at/above speech — so speech is preserved while
 * noise-only gaps are attenuated. Below threshold we apply a SOFT expansion
 * curve (not a hard mute), and the gain envelope is smoothed to avoid pumping.
 * This is what makes denoising actually IMPROVE transcription instead of
 * starving the recognizer of signal.
 */
function applyNoiseGate(buffer, strength) {
  if (strength <= 0.001) return;
  const sr = buffer.sampleRate;
  const frame = Math.max(256, Math.floor(sr * 0.02)); // ~20 ms frames

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    const nFrames = Math.ceil(data.length / frame);
    const rms = new Float32Array(nFrames);

    for (let f = 0; f < nFrames; f++) {
      let sum = 0;
      const start = f * frame;
      const end = Math.min(start + frame, data.length);
      for (let i = start; i < end; i++) sum += data[i] * data[i];
      rms[f] = Math.sqrt(sum / (end - start || 1));
    }

    // Estimate floor (quiet) and speech (loud) levels from the distribution.
    const sorted = Float32Array.from(rms).sort();
    const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
    const speech = sorted[Math.floor(sorted.length * 0.85)] || floor;

    // Threshold sits a fraction of the way from floor toward speech — scaling
    // with strength but capped so it can never reach the speech level.
    const threshold = floor + Math.min(0.6, strength * 0.55) * (speech - floor);
    if (threshold <= 0) continue;

    // How hard noise-only frames get pulled down (more with strength).
    const gainFloor = 0.3 - strength * 0.24; // 0.30 → 0.06

    // smoothed gain envelope (fast to open, slower to close)
    let gain = 1;
    const attack = 0.5;
    const release = 0.12;
    for (let f = 0; f < nFrames; f++) {
      let target;
      if (rms[f] >= threshold) {
        target = 1;
      } else {
        const ratio = rms[f] / threshold; // 0..1
        target = Math.max(gainFloor, Math.pow(ratio, 1.5));
      }
      const coef = target > gain ? attack : release;
      gain += (target - gain) * coef;

      const start = f * frame;
      const end = Math.min(start + frame, data.length);
      for (let i = start; i < end; i++) data[i] *= gain;
    }
  }
}

// ---------------------------------------------------------------------------
// Down-mix to mono at the source rate (memory saver for long files)
// ---------------------------------------------------------------------------
async function downmixToMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer;
  const off = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

// ---------------------------------------------------------------------------
// Resample → 16 kHz mono Float32 (Whisper input)
// ---------------------------------------------------------------------------
async function toMono16k(buffer) {
  const targetSr = 16000;
  const length = Math.ceil(buffer.duration * targetSr);
  const off = new OfflineAudioContext(1, length, targetSr);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

// ---------------------------------------------------------------------------
// WAV encoding (for the cleaned-audio player + export)
// ---------------------------------------------------------------------------
function encodeWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
function ensureWorker() {
  if (state.worker) return state.worker;
  // Version query busts any stale cached worker when the script is updated.
  const worker = new Worker(
    new URL(`./transcribe.worker.js?v=${APP_VERSION}`, import.meta.url),
    { type: "module" }
  );
  worker.addEventListener("message", onWorkerMessage);
  worker.addEventListener("error", (e) => {
    console.error("worker error", e);
    setStatus("Worker error: " + (e.message || "see console"), "err");
    finishBusy();
  });
  state.worker = worker;
  return worker;
}

function onWorkerMessage(e) {
  const msg = e.data;
  switch (msg.type) {
    case "backend":
      state.backend = msg.backend;
      state.model = msg.model;
      dom["backend-pill"].textContent =
        `${msg.backend.toUpperCase()} · ${msg.model.split("/").pop()}`;
      break;
    case "load-progress":
      handleLoadProgress(msg.progress);
      break;
    case "ready":
      state.workerReady = true;
      setProgress(0.55, "Model ready · transcribing…");
      break;
    case "fallback":
      // WebGPU init failed on this browser → transparently using WASM instead.
      console.warn(`WebGPU unavailable, falling back to WASM: ${msg.error}`);
      setStatus("WebGPU unavailable — using WASM", "work");
      break;
    case "infer-tick":
      // nudge the bar forward during inference (asymptotic toward 0.98)
      nudgeProgress();
      break;
    case "result":
      onResult(msg);
      break;
    case "error":
      console.error(msg.error);
      setStatus("Error: " + msg.error, "err");
      finishBusy();
      break;
  }
}

const fileProgress = {};
function handleLoadProgress(p) {
  if (!p) return;
  if (p.status === "progress" && p.file) {
    fileProgress[p.file] = p.progress || 0;
    const vals = Object.values(fileProgress);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    // model download occupies 0–50% of our bar
    setProgress(Math.min(0.5, (avg / 100) * 0.5), `Downloading model… ${Math.round(avg)}%`);
  } else if (p.status === "ready" || p.status === "done") {
    // handled by 'ready'
  } else if (p.status === "initiate") {
    setProgress(0.04, "Fetching model shards…");
  }
}

let nudgeVal = 0.55;
function nudgeProgress() {
  nudgeVal = Math.min(0.98, nudgeVal + (0.98 - nudgeVal) * 0.02);
  setProgress(nudgeVal, "Transcribing on-device…");
}

// ---------------------------------------------------------------------------
// Main process pipeline
// ---------------------------------------------------------------------------
async function process() {
  if (state.busy || !state.audioBuffer) return;
  startBusy();
  nudgeVal = 0.55;

  const strength = parseInt(dom["noise-slider"].value, 10) / 100;
  const language = dom["lang-select"].value;
  const size = dom["model-select"].value;

  let useAI = dom["ai-denoise"].checked;
  // DeepFilterNet runs at 48 kHz and buffers the whole file — too memory-heavy
  // for very long inputs. Transparently drop to the lightweight DSP path.
  if (useAI && state.durationSec > AI_DENOISE_MAX_SEC) {
    useAI = false;
    setStatus(
      `AI denoise capped at ${AI_DENOISE_MAX_SEC / 60} min — using DSP`,
      "work"
    );
    console.warn("DeepFilterNet skipped for long file (memory); using DSP.");
  }

  try {
    // For long files, collapse to mono up front to roughly halve the memory
    // used by every downstream full-length buffer (denoise, WAV, peaks).
    let source = state.audioBuffer;
    if (state.durationSec > LONG_FILE_SEC && source.numberOfChannels > 1) {
      setProgress(0.03, "Down-mixing to mono (long file)…");
      await new Promise((r) => setTimeout(r));
      source = await downmixToMono(source);
    }

    let cleaned;
    if (useAI) {
      setProgress(0.04, "Loading DeepFilterNet3 (neural AI)…");
      await new Promise((r) => setTimeout(r)); // let UI paint
      try {
        cleaned = await denoiseAI(source, strength * 100);
      } catch (e) {
        console.error("DeepFilterNet failed — falling back to DSP", e);
        setStatus("AI denoise unavailable — using DSP fallback", "work");
        cleaned = await denoise(source, strength);
      }
    } else {
      setProgress(0.04, "Applying AI noise reduction…");
      await new Promise((r) => setTimeout(r)); // let UI paint
      cleaned = await denoise(source, strength);
    }
    state.cleanedBuffer = cleaned;

    // cleaned player
    if (state.cleanedWavUrl) URL.revokeObjectURL(state.cleanedWavUrl);
    const wav = encodeWav(cleaned);
    state.cleanedWavUrl = URL.createObjectURL(wav);
    dom["audio-player"].src = state.cleanedWavUrl;
    state.peaks = computePeaks(cleaned, 1400);
    drawWaveform(0);

    setProgress(0.16, "Resampling to 16 kHz mono…");
    await new Promise((r) => setTimeout(r));
    const mono = await toMono16k(cleaned);

    setProgress(0.2, "Spinning up local AI worker…");
    const worker = ensureWorker();
    // Transfer the PCM buffer (zero-copy) to the worker.
    worker.postMessage(
      { type: "transcribe", payload: { audio: mono, language, size } },
      [mono.buffer]
    );
  } catch (err) {
    console.error(err);
    setStatus("Processing failed: " + (err.message || err), "err");
    finishBusy();
  }
}

function onResult(msg) {
  setProgress(1, "Done");
  renderTranscript(msg.text, msg.chunks);
  state.backend = msg.backend;
  state.model = msg.model;
  dom["backend-pill"].textContent =
    `${msg.backend.toUpperCase()} · ${msg.model.split("/").pop()}`;

  const words = (msg.text.match(/\S+/g) || []).length;
  dom["roi-words"].textContent = words.toLocaleString();
  const procSec = msg.process_ms / 1000;
  const rt = state.durationSec > 0 ? state.durationSec / procSec : 0;
  dom["wpm"].textContent =
    `${procSec.toFixed(1)}s · ${rt.toFixed(1)}× realtime`;

  updateROI();
  setStatus("Complete · $0.00 spent", "ok");
  saveHistory(msg, words).catch(() => {});
  finishBusy();
}

function renderTranscript(text, chunks) {
  const el = dom["transcript"];
  el.innerHTML = "";
  if (chunks && chunks.length) {
    for (const c of chunks) {
      const ts = c.timestamp || [0, 0];
      const row = document.createElement("div");
      row.className = "ts-row";
      const t = document.createElement("button");
      t.className = "ts-time";
      t.textContent = fmtTime(ts[0] || 0);
      t.title = "Jump to " + fmtTime(ts[0] || 0);
      t.addEventListener("click", () => {
        const a = dom["audio-player"];
        a.currentTime = ts[0] || 0;
        a.play();
      });
      const span = document.createElement("span");
      span.className = "ts-text";
      span.textContent = (c.text || "").trim();
      row.appendChild(t);
      row.appendChild(span);
      el.appendChild(row);
    }
  } else {
    const p = document.createElement("div");
    p.className = "ts-row";
    p.textContent = text || "(no speech detected)";
    el.appendChild(p);
  }
  el.dataset.plain = text || "";
  el.dataset.chunks = JSON.stringify(chunks || []);
  dom["copy-btn"].disabled = false;
  dom["txt-btn"].disabled = false;
  dom["srt-btn"].disabled = false;
}

// ---------------------------------------------------------------------------
// ROI meter
// ---------------------------------------------------------------------------
function updateROI() {
  const minutes = state.durationSec / 60;
  const saved = minutes * CLOUD_RATE_PER_MIN;
  dom["roi-saved"].textContent = `$${saved.toFixed(4)}`;
  dom["roi-time"].textContent = fmtTime(state.durationSec);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
function download(name, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function baseName() {
  return (state.fileName || "transcript").replace(/\.[^.]+$/, "");
}
function exportTxt() {
  download(baseName() + ".txt", dom["transcript"].dataset.plain || "", "text/plain");
}
function exportSrt() {
  const chunks = JSON.parse(dom["transcript"].dataset.chunks || "[]");
  let out = "";
  chunks.forEach((c, i) => {
    const [s, e] = c.timestamp || [0, 0];
    out += `${i + 1}\n${srtTime(s || 0)} --> ${srtTime(e || s || 0)}\n${(c.text || "").trim()}\n\n`;
  });
  download(baseName() + ".srt", out, "text/plain");
}
async function copyTranscript() {
  try {
    await navigator.clipboard.writeText(dom["transcript"].dataset.plain || "");
    flash(dom["copy-btn"], "Copied ✓");
  } catch {
    flash(dom["copy-btn"], "Copy failed");
  }
}
function flash(btn, txt) {
  const old = btn.textContent;
  btn.textContent = txt;
  setTimeout(() => (btn.textContent = old), 1400);
}

// ---------------------------------------------------------------------------
// Optional local history (only if FastAPI server is running)
// ---------------------------------------------------------------------------
async function saveHistory(msg, words) {
  try {
    await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: state.fileName,
        language: dom["lang-select"].value,
        model: msg.model,
        backend: msg.backend,
        duration_sec: state.durationSec,
        process_ms: msg.process_ms,
        noise_strength: parseInt(dom["noise-slider"].value, 10) / 100,
        cloud_cost_saved: (state.durationSec / 60) * CLOUD_RATE_PER_MIN,
        transcript: (msg.text || "").slice(0, 20000),
      }),
    });
  } catch {
    /* server not running — pure static mode, totally fine */
  }
}

// ---------------------------------------------------------------------------
// Busy / progress helpers
// ---------------------------------------------------------------------------
function startBusy() {
  state.busy = true;
  dom["process-btn"].disabled = true;
  dom["progress-wrap"].classList.add("show");
  setStatus("Processing locally…", "work");
}
function finishBusy() {
  state.busy = false;
  dom["process-btn"].disabled = !state.audioBuffer;
  setTimeout(() => dom["progress-wrap"].classList.remove("show"), 800);
}
function setProgress(frac, label) {
  dom["progress-bar"].style.width = `${Math.round(frac * 100)}%`;
  if (label) dom["progress-label"].textContent = label;
}

function resetOutputs() {
  dom["transcript"].innerHTML =
    '<div class="ts-placeholder">Timestamped transcript will appear here…</div>';
  dom["transcript"].dataset.plain = "";
  dom["transcript"].dataset.chunks = "[]";
  ["copy-btn", "txt-btn", "srt-btn"].forEach((k) => (dom[k].disabled = true));
  dom["roi-words"].textContent = "0";
  dom["wpm"].textContent = "—";
  if (state.cleanedWavUrl) {
    URL.revokeObjectURL(state.cleanedWavUrl);
    state.cleanedWavUrl = null;
  }
  dom["audio-player"].removeAttribute("src");
}

function fullReset() {
  cancelAnimationFrame(state.rafId);
  resetOutputs();
  state.audioBuffer = null;
  state.cleanedBuffer = null;
  state.peaks = null;
  state.durationSec = 0;
  state.fileName = null;
  dom["stage"].classList.remove("active");
  dom["process-btn"].disabled = true;
  setStatus("Awaiting media", "idle");
  updateROI();
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
function init() {
  bindDom();

  const dz = dom["drop-zone"];
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
    })
  );
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files?.[0];
    if (f) loadFile(f);
  });
  // whole-window drop convenience
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  dom["browse-btn"].addEventListener("click", () => dom["file-input"].click());
  dz.addEventListener("click", (e) => {
    if (e.target.closest("#browse-btn")) return;
    dom["file-input"].click();
  });
  dom["file-input"].addEventListener("change", (e) =>
    loadFile(e.target.files?.[0])
  );

  dom["noise-slider"].addEventListener("input", (e) => {
    dom["noise-val"].textContent = `${e.target.value}%`;
  });

  dom["model-select"].addEventListener("change", onModelChange);
  dom["lang-select"].addEventListener("change", () => {
    if (!state.busy) prewarm();
  });

  dom["ai-denoise"].addEventListener("change", (e) => {
    const on = e.target.checked;
    dom["ai-state"].textContent = on ? "On · DeepFilterNet3" : "Off";
    dom["noise-label"].textContent = on ? "AI Suppression" : "Noise Cancel";
    if (on) loadDFModule().catch(() => {}); // warm the library import early
  });

  dom["process-btn"].addEventListener("click", process);
  dom["reset-btn"].addEventListener("click", fullReset);
  dom["demo-btn"].addEventListener("click", runDemo);

  dom["play-btn"].addEventListener("click", () => {
    const a = dom["audio-player"];
    if (!a.src) return;
    a.paused ? a.play() : a.pause();
  });
  const a = dom["audio-player"];
  a.addEventListener("play", startPlayheadLoop);
  a.addEventListener("timeupdate", () => {
    if (a.paused) drawWaveform((a.currentTime || 0) / (a.duration || 1));
  });
  a.addEventListener("ended", () => drawWaveform(1));

  dom["copy-btn"].addEventListener("click", copyTranscript);
  dom["txt-btn"].addEventListener("click", exportTxt);
  dom["srt-btn"].addEventListener("click", exportSrt);

  window.addEventListener("resize", () => state.peaks && drawWaveform());

  // Warm up the worker + start caching the model in the background as soon as
  // the page is idle, so the first real transcription is instant. UI stays
  // 100% responsive because this runs on the worker thread.
  if ("requestIdleCallback" in window) {
    requestIdleCallback(() => prewarm());
  } else {
    setTimeout(prewarm, 1500);
  }

  setStatus("Awaiting media", "idle");
  updateROI();
}

function prewarm() {
  try {
    const worker = ensureWorker();
    worker.postMessage({
      type: "load",
      payload: {
        language: dom["lang-select"].value,
        size: dom["model-select"].value,
      },
    });
  } catch (e) {
    console.warn("prewarm skipped", e);
  }
}

const MODEL_HINTS = { tiny: "fastest", base: "balanced", small: "most accurate" };
function onModelChange() {
  dom["model-hint"].textContent = MODEL_HINTS[dom["model-select"].value] || "";
  if (!state.busy) prewarm(); // pre-cache the newly selected model in the background
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
