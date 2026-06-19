/*
 * Sovereign Audio Studio — Transcription Web Worker
 * =================================================
 * Runs the Whisper speech-to-text pipeline on a background thread so the main
 * UI never freezes — not during the (potentially large) first model download,
 * and not during the heavy inference loop.
 *
 * Backend selection:
 *   - WebGPU when available (orders of magnitude faster).
 *   - Transparent fallback to WASM otherwise.
 *
 * 100% SOVEREIGN: the transformers.js library, the ONNX Runtime WASM, and the
 * Whisper models are ALL self-hosted under /static — no third-party CDN is ever
 * contacted, so the app works on first load behind a firewall / air-gapped and
 * no audio (or even telemetry) ever leaves the device.
 */

import {
  pipeline,
  env,
} from "/static/vendor/transformers/transformers.min.js";

// Models are served from our own origin only — never reach out to the HF CDN.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = "/static/models/";
env.useBrowserCache = true;
// Self-hosted ONNX Runtime WASM (no CDN).
env.backends.onnx.wasm.wasmPaths = "/static/vendor/transformers/";

// We are ALREADY inside a dedicated Web Worker. ONNX Runtime must therefore not
// try to spawn its own nested proxy/pthread workers — when transformers.js is
// loaded from a cross-origin CDN, constructing those nested workers is blocked
// by the same-origin policy ("cannot be accessed from origin ..."). Running ORT
// inline in this worker (proxy off, single-thread WASM) keeps it fully working.
// WebGPU remains the fast path; this only affects the WASM fallback's threading.
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = 1;

/**
 * Pipeline factory — singleton per (model, backend) so switching languages
 * doesn't needlessly reload an identical model.
 */
class PipelineSingleton {
  static instance = null; // resolved pipeline
  static key = null; // key of the resolved instance
  static loading = null; // in-flight load promise
  static loadingKey = null; // key of the in-flight load

  static async get(model, backend, progress_callback) {
    const key = `${model}::${backend}`;

    // Already loaded for this exact model+backend.
    if (this.instance && this.key === key) return this.instance;

    // A load for this exact key is already in flight — share it (prevents the
    // background pre-warm and the actual transcribe from each downloading the
    // same model twice, and prevents returning the wrong/stale model).
    if (this.loading && this.loadingKey === key) return this.loading;

    // Start a fresh load; it supersedes any other model.
    this.loadingKey = key;
    this.loading = (async () => {
      if (this.instance) {
        try {
          await this.instance.dispose(); // free GPU/WASM memory
        } catch (_) {
          /* best effort */
        }
        this.instance = null;
        this.key = null;
      }
      const options = {
        progress_callback,
        device: backend === "webgpu" ? "webgpu" : "wasm",
        // WebGPU is reliable + accurate only with fp32 for Whisper in this
        // runtime (q8/fp16/q4f16 hang or garble on GPU). WASM uses the compact
        // q8 weights. Both dtypes are self-hosted under /static/models.
        dtype: backend === "webgpu" ? "fp32" : "q8",
      };
      const inst = await pipeline("automatic-speech-recognition", model, options);
      // Only adopt as the cached instance if this is still the latest requested
      // load (a newer selection may have superseded us while downloading).
      if (this.loadingKey === key) {
        this.instance = inst;
        this.key = key;
      }
      return inst;
    })();

    try {
      return await this.loading;
    } finally {
      if (this.loadingKey === key) {
        this.loading = null;
        this.loadingKey = null;
      }
    }
  }
}

/**
 * Pick the self-hosted model for the requested size tier. We ship the
 * multilingual checkpoints only (they handle English well via the `language`
 * param), which keeps the bundled footprint small while covering ~99 languages.
 */
function pickModel(language, size) {
  return size === "tiny" ? "Xenova/whisper-tiny" : "Xenova/whisper-base";
}

async function detectBackend() {
  // Explicit override (e.g. worker URL "...transcribe.worker.js?backend=wasm")
  // lets users force the WASM path on machines where WebGPU misbehaves.
  try {
    const forced = new URLSearchParams(self.location.search).get("backend");
    if (forced === "wasm" || forced === "webgpu") return forced;
  } catch (_) {
    /* ignore */
  }
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    } catch (_) {
      /* fall through */
    }
  }
  return "wasm";
}

let WARMED = false;

self.addEventListener("message", async (event) => {
  const { type, payload } = event.data;

  try {
    if (type === "load") {
      await handleLoad(payload);
    } else if (type === "transcribe") {
      await handleTranscribe(payload);
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      error: err?.message || String(err),
    });
  }
});

/**
 * Resolve a transcriber, preferring WebGPU but transparently falling back to
 * WASM if WebGPU initialisation fails. This is the key cross-browser safety
 * net: some browsers expose `navigator.gpu` yet fail to actually build a GPU
 * pipeline (driver quirks, Safari/Firefox partial support, blocklisted GPUs).
 * Rather than erroring out, we silently drop to the universally-supported WASM
 * path so EVERY browser produces a result.
 */
async function resolveTranscriber(model, onProgress) {
  let backend = await detectBackend();
  try {
    const transcriber = await PipelineSingleton.get(model, backend, onProgress);
    return { transcriber, backend };
  } catch (err) {
    if (backend !== "webgpu") throw err;
    self.postMessage({
      type: "fallback",
      from: "webgpu",
      to: "wasm",
      error: err?.message || String(err),
    });
    backend = "wasm";
    const transcriber = await PipelineSingleton.get(model, backend, onProgress);
    return { transcriber, backend };
  }
}

async function handleLoad({ language, size }) {
  const model = pickModel(language, size);
  const onProgress = (p) =>
    self.postMessage({ type: "load-progress", progress: p });

  const { backend } = await resolveTranscriber(model, onProgress);

  WARMED = true;
  self.postMessage({ type: "backend", backend, model });
  self.postMessage({ type: "ready", backend, model });
}

async function handleTranscribe({ audio, language, size }) {
  const model = pickModel(language, size);
  const onProgress = (p) =>
    self.postMessage({ type: "load-progress", progress: p });

  const { transcriber, backend } = await resolveTranscriber(model, onProgress);

  // Report the *actual* backend (may differ from detection after a fallback).
  self.postMessage({ type: "backend", backend, model });
  if (!WARMED) {
    WARMED = true;
    self.postMessage({ type: "ready", backend, model });
  }

  const started = performance.now();

  const options = {
    // chunked long-form decoding so arbitrarily long files work
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    // streaming progress callback (per generated step)
    callback_function: (beams) => {
      // Lightweight heartbeat so the UI bar keeps moving during inference.
      self.postMessage({ type: "infer-tick" });
    },
  };

  // Multilingual model: force the target language when the user picked one.
  if (language && language !== "auto") {
    options.language = language;
    options.task = "transcribe";
  }

  const output = await transcriber(audio, options);
  const elapsed = performance.now() - started;

  self.postMessage({
    type: "result",
    text: output.text?.trim() ?? "",
    chunks: output.chunks ?? [],
    process_ms: elapsed,
    backend,
    model,
  });
}
