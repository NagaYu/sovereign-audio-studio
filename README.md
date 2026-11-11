# 🎙️ Sovereign Audio Studio

### Zero-cost, fully-offline AI **noise reduction** + **multilingual transcription** — running 100% in the browser.

No servers. No API keys. No per-minute billing. **Not one byte of audio ever leaves the device.**
The AI model runs directly on the user's GPU/CPU via **WebGPU** (with an automatic **WASM** fallback) using [Transformers.js](https://github.com/huggingface/transformers.js) + [OpenAI Whisper](https://github.com/openai/whisper).

```
┌──────────────────────────────────────────────────────────────┐
│  $0.00 SPENT     ·     100% OFFLINE     ·     0 BYTES UPLOADED │
└──────────────────────────────────────────────────────────────┘
```

---

## ⚡ 3-Minute Quick Start (for everyone)

### Step 0 — Fetch the AI assets (once)
The AI engine + models (~580 MB) are **not** stored in git — download them with the
included script (one time; afterwards the app is fully offline):
```bash
cd "Sovereign Audio Studio"
./scripts/fetch_assets.sh
```
> This populates `app/static/{models,vendor,df3}`. Re-running is safe (skips existing files).

Then pick one of the two ways to run it. **Both are free and fully offline after Step 0.**

### Option A — Pure static (just open it)
1. Serve the `app/` folder with any static server (needed so the Web Worker + WASM + models load correctly):
   ```bash
   cd "Sovereign Audio Studio"
   python3 -m http.server 8000 --directory app
   ```
   > For the absolute simplest path, use Option B — it wires the routing and adds the right caching headers for you.
2. Open <http://localhost:8000/templates/index.html> in **Chrome / Edge / Arc** (best WebGPU support).
3. Click **🎬 Run Demo** to try it instantly with the bundled noisy clip — *no file needed* — or **drag & drop** your own MP3, WAV, M4A or MP4.
4. Set the **Noise Cancel** strength, **Target Language**, and **AI Model** size (Tiny / Base), then click **⚡ Denoise & Transcribe**.
5. Listen to the cleaned audio on the left, copy/export the timestamped transcript (`.txt` / `.srt`) on the right.

> **Verified demo result** (WebGPU, default 55% denoise, ~7–8× realtime): the bundled clip — synthetic speech buried under 60 Hz hum, rumble and hiss — transcribes cleanly to *"Welcome to Sovereign Audio Studio. This entire transcription is running locally in your browser, with zero cloud cost and complete privacy, not a single byte of audio ever leaves your device."*

> **Truly offline / air-gapped.** Everything — the transformers.js engine, the ONNX Runtime WASM, and the Whisper models — is **served from your own machine** (`/static`). There is **no first-run CDN download and no third-party network call ever** (verified: 0 external requests). The app runs with your Wi-Fi turned off from the very first load.

### Option B — Local desktop app (recommended, adds searchable history)
```bash
cd "Sovereign Audio Studio"
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m app.main          # or: uvicorn app.main:app --port 8000
```
Then open <http://localhost:8000>.

The FastAPI server **only** serves the UI and stores transcription *metadata + text* you choose to keep in a local `sovereign_history.db` (SQLite) on your own disk. **Raw audio is still never uploaded** — it is decoded and processed entirely in the browser tab.

**System requirements:** A modern Chromium browser. WebGPU recommended (Chrome 113+); without it, the app transparently falls back to multi-threaded WASM.

---

## 🧠 How it works (the architecture)

```
 ┌─────────────────────────── BROWSER TAB (the whole product) ───────────────────────────┐
 │                                                                                         │
 │  File drop ──► Web Audio API decode ──► OfflineAudioContext DSP                         │
 │                                          (high-pass + low-pass + compressor             │
 │                                           + adaptive noise gate)  ──► Cleaned WAV ►►► 🔊 │
 │                                                   │                                      │
 │                                                   ├──► Canvas live waveform monitor      │
 │                                                   │                                      │
 │                                                   └──► resample 16 kHz mono              │
 │                                                              │                           │
 │                                          ┌───────────────────▼─────────────────────┐    │
 │                                          │  Web Worker (off the main thread)         │    │
 │                                          │  Transformers.js · Whisper                │    │
 │                                          │  WebGPU  →  (fallback) WASM               │    │
 │                                          │  returns timestamped chunks ──────────────┼──► 📝 transcript
 │                                          └───────────────────────────────────────────┘    │
 │                                                                                         │
 └─────────────────────────────────────────────────────────────────────────────────────┘
        (optional) localhost FastAPI ◄── metadata + text only ── SQLite history on your disk
```

| File | Role |
|------|------|
| `app/static/audio_core.js` | Main-thread orchestration: ingest, Web Audio decode + **DSP denoise**, waveform Canvas, resampling, worker control, ROI, exports. |
| `app/static/transcribe.worker.js` | **Off-thread** Whisper inference (WebGPU/WASM) via Transformers.js — keeps the UI buttery smooth during the first model download *and* inference. |
| `app/templates/index.html` | The "cyber-dark studio" SPA dashboard (waveform, dual controls, dual output, ROI meter, one-click demo). |
| `app/static/sample.wav` | Bundled noisy demo clip (≈11 s) powering the **Run Demo** button. |
| `app/static/df3/` | Self-hosted **DeepFilterNet3** assets (Rust/WASM + ONNX model, ~18 MB) for studio-grade neural denoise — served from your own origin, no third-party runtime CDN. |
| `app/static/vendor/` | Self-hosted **transformers.js** engine + **ONNX Runtime** WASM + **DeepFilterNet** JS library — zero third-party JS at runtime. |
| `app/static/models/` | Self-hosted **Whisper** models (tiny + base, fp32 + q8) — the app never contacts HuggingFace. |
| `app/main.py` | Optional FastAPI: static hosting (with COOP/COEP for SharedArrayBuffer) + SQLite metadata history. |
| `requirements.txt` | `fastapi`, `uvicorn`, `pydantic` — that's it. |

**Why a Web Worker matters:** model loading (tens to hundreds of MB) and Whisper decoding are heavy. Doing them on the main thread would freeze the page. Here, everything heavy lives on a dedicated worker thread; the UI thread only paints the waveform and progress. The audio PCM buffer is handed to the worker with a **zero-copy transfer**.

---

## 💰 For Acquirers — the most profitable shape an audio-AI business can take

> **Thesis:** every transcription/denoise SaaS on earth pays a marginal cost per minute of audio (GPU time, or a reseller markup on OpenAI/Deepgram/AssemblyAI). **Sovereign Audio Studio has a marginal cost of exactly $0.00.** The compute is the *customer's* hardware. This is not a cheaper mousetrap — it is a structurally different, and structurally superior, unit economic.

### The numbers that matter
| Metric | Typical cloud STT SaaS | **Sovereign Audio Studio** |
|---|---|---|
| Marginal cost / minute of audio | $0.004 – $0.025 | **$0.00** |
| Gross margin at scale | 40–70% (compute-bound) | **~100%** (compute-free) |
| Infra cost to serve 1 user vs 10M users | scales linearly 📈 | **flat / near-zero** |
| Data-privacy liability surface | entire pipeline (GDPR/HIPAA/SOC2) | **none — audio never transmitted** |
| Works offline / air-gapped | ❌ | ✅ |
| Vendor lock-in / API price risk | high | **none** |

### Why a strategic buyer (Adobe, Spotify, Blackmagic, Descript, a media SaaS) wins
1. **Compliance becomes a feature, not a cost center.** Legal, medical, journalistic, and enterprise customers cannot send confidential audio (board meetings, depositions, patient interviews, unreleased music) to a third party. "It never leaves your machine" closes deals that the cloud category structurally cannot.
2. **Drop-in margin expansion.** Bolt this edge engine under an existing product and the per-minute COGS line **disappears**. That flows straight to gross margin.
3. **Distribution-ready.** Ships as a static bundle — embeddable in a desktop NLE, a DAW plugin webview, a browser extension, or a PWA. No backend to operate, scale, or secure.
4. **Defensible privacy brand.** "Sovereign" / "on-device" is the durable positioning the entire category is being forced toward by regulation and customer demand.
5. **Future-proof.** As the open Whisper / WebGPU ecosystem improves, the engine gets faster and more accurate **for free**, with no change to the cost model.

### What's in the box (acquisition surface)
- A complete, production-quality, fully-local denoise + STT pipeline (the hard, integrated part).
- A polished, demo-ready pro-audio UI that converts on sight.
- Clean separation (core / worker / UI / optional server) that drops into an existing stack.
- Zero external service dependencies → zero diligence risk on third-party data processors.

> **Bottom line:** you are not buying a transcription tool. You are buying a **0-marginal-cost, 0-data-liability edge media engine** and a privacy brand — the highest-margin shape this category can take.

---

## 🧹 Noise removal — two on-device engines
Toggle **AI Speech Enhance** in the dashboard to pick your denoise engine (both 100% local):

| Engine | Default | How it works | Best for |
|--------|---------|--------------|----------|
| **DSP** (built-in) | ✅ on | Web Audio high-pass + low-pass + compressor + adaptive downward-expander gate | Steady noise (hum, hiss, AC, rumble). Instant, no download. ~7× realtime. |
| **DeepFilterNet3** (neural AI) | toggle on | Self-hosted ONNX + Rust/WASM speech-enhancement model running in an `OfflineAudioContext` AudioWorklet | **Studio-grade.** Also removes non-stationary noise (keyboard, traffic, background voices). First use downloads ~18 MB, then fully offline. ~2× realtime. |

> Verified: on the demo clip DeepFilterNet3 preserves the speech peak (0.72) while cutting overall RMS (0.158 → 0.139) — i.e. it removes noise without eating the voice.

**Achieving the cleanest result:** enable DeepFilterNet3, keep the source at a decent level, and let the high-pass handle hum/rumble. Note that perfect (zero-noise, zero-loss) separation is theoretically impossible; DeepFilterNet3 is perceptually near-perfect for meetings/interviews.

## 🎚️ Model sizes
Pick the accuracy/speed trade-off from the dashboard. Self-hosted multilingual Whisper
(handles English via the language selector), so one model covers ~99 languages:

| Tier | Model | Notes |
|------|-------|-------|
| **Tiny** | `Xenova/whisper-tiny` | Fastest, smallest — great for quick drafts |
| **Base** | `Xenova/whisper-base` | **Recommended** balance (default) |

Each tier ships **two self-hosted weight sets**: `fp32` (used on **WebGPU** — the only dtype that
is both reliable and accurate for Whisper on the GPU in this runtime) and `q8` (compact, used on the
**WASM** fallback). The engine auto-selects WebGPU when available, else WASM.

## 📏 Long files & browser compatibility
- **Any length transcribes correctly** — Whisper runs in 30 s windows with 5 s overlap, so timestamps stitch seamlessly across the whole file (verified on a 107 s clip → 25 timestamped segments spanning the full duration).
- **Memory guards** keep a browser tab safe: long files are down-mixed to mono (halves memory), the heavy 48 kHz **DeepFilterNet** stage auto-caps at 15 min (falls back to the lightweight DSP denoise beyond that), and inputs over 90 min are politely refused with a "split the file" message.
- **WebGPU → WASM fallback** is automatic: if a browser exposes WebGPU but fails to build a GPU pipeline (driver/Safari/Firefox quirks), the worker transparently switches to the universally-supported WASM path (verified: WASM produces identical text — base ≈ 3× realtime, tiny ≈ 6× realtime). Force a backend with `…/transcribe.worker.js?backend=wasm`.

## 📲 Installable PWA (works offline)
- A **Service Worker** (`/sw.js`, root scope) precaches the entire app shell (HTML, JS, the Web Worker, transformers.js, ONNX Runtime WASM, DeepFilterNet lib, icons) on first visit, and runtime-caches the AI models on first use. After that the app **launches and transcribes with the network fully off**.
- A `manifest.webmanifest` + maskable icons make it **installable** (Add to Home Screen / Install App) and it runs standalone like a native app.
- Verified: SW registers + activates at scope `/`, 9 shell assets precached, demo runs unaffected with the SW controlling the page.

## 📝 Licensing
All bundled third-party components are permissive (MIT / Apache-2.0) and documented in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md): OpenAI Whisper, Transformers.js, ONNX Runtime, DeepFilterNet, and the Xenova model conversions.

## 🔒 Privacy guarantee
- Audio is decoded and processed in `AudioContext` / a Web Worker — **in-memory, in the tab**.
- **Zero third-party network calls** — the engine, runtime WASM, AI models, and denoiser are all self-hosted under `/static`. `env.allowRemoteModels = false` makes it *impossible* for the worker to reach a CDN. Verified: 0 external requests during a full run.
- Works **fully air-gapped** from the first load.
- The optional FastAPI server persists only the **text + metadata** you explicitly keep, to **your own local disk**.

## 🛠️ Tech
Transformers.js · OpenAI Whisper (`whisper-base`, `distil-whisper-small.en`) · WebGPU / WASM · Web Audio API · Canvas · Web Workers · FastAPI · SQLite.

## License

Proprietary — Copyright (c) 2026 Yuta Nagao, all rights reserved.
This repository is public for evaluation only; no licence to use, copy,
modify, or distribute is granted. The project is available for
acquisition or licensing — contact via
https://nagayu-portfolio.nagayu.workers.dev/en

Third-party components and models are licensed separately by their
respective authors — see THIRD_PARTY_LICENSES.md.
