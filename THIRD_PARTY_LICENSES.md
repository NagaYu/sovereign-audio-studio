# Third-Party Licenses & Attributions

Sovereign Audio Studio **self-hosts** several open-source components under
`app/static/`. This file documents their licenses and attributions. All are
permissive (MIT / Apache-2.0) and permit redistribution; retain these notices
when distributing the bundle.

| Component | Files | License | Source |
|-----------|-------|---------|--------|
| **OpenAI Whisper** (model architecture & weights) | `app/static/models/Xenova/whisper-*` | MIT | https://github.com/openai/whisper |
| **Transformers.js** (`@huggingface/transformers` 3.1.2) | `app/static/vendor/transformers/transformers.min.js` | Apache-2.0 | https://github.com/huggingface/transformers.js |
| **ONNX Runtime Web** (bundled WASM) | `app/static/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm` | MIT | https://github.com/microsoft/onnxruntime |
| **Whisper ONNX conversions** (Xenova) | `app/static/models/Xenova/whisper-*` | Apache-2.0 | https://huggingface.co/Xenova |
| **DeepFilterNet** (speech-enhancement model + Rust/WASM) | `app/static/df3/v2/**` | MIT / Apache-2.0 (dual) | https://github.com/Rikorose/DeepFilterNet |
| **deepfilternet3-noise-filter** (JS wrapper, 1.2.1) | `app/static/vendor/deepfilternet3.esm.js` | MIT / Apache-2.0 | https://www.npmjs.com/package/deepfilternet3-noise-filter |

## Notices

### OpenAI Whisper — MIT License
Copyright (c) 2022 OpenAI

### Transformers.js — Apache License 2.0
Copyright (c) Hugging Face. Licensed under the Apache License, Version 2.0.

### Microsoft ONNX Runtime — MIT License
Copyright (c) Microsoft Corporation.

### DeepFilterNet — MIT / Apache-2.0
Copyright (c) Hendrik Schröter et al. See the upstream `LICENSE-MIT` and
`LICENSE-APACHE` for full terms.

---

Full Apache-2.0 and MIT license texts are available at:
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
- MIT: https://opensource.org/license/mit

> Sovereign Audio Studio itself does not transmit, collect, or redistribute any
> user audio or text. These third-party components run entirely on-device.
