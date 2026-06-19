#!/usr/bin/env bash
#
# Sovereign Audio Studio — one-time asset fetcher
# ===============================================
# Downloads the self-hosted AI engine + models into app/static so the app runs
# 100% offline afterwards. These are kept OUT of git (see .gitignore) because
# they are large binaries. Re-running is safe — existing files are skipped.
#
# Total download: ~580 MB. Requires: bash, curl.
#
#   ./scripts/fetch_assets.sh
#
set -euo pipefail

# Resolve repo root (this script lives in scripts/)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATIC="$ROOT/app/static"

HF="https://huggingface.co"
JSD="https://cdn.jsdelivr.net/npm"
DF_CDN="https://cdn.laptrinhai.id.vn/deepfilternet3"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
skip() { printf "  \033[90m•\033[0m %s (exists)\n" "$1"; }
info() { printf "\n\033[36m▸ %s\033[0m\n" "$1"; }

# fetch <url> <dest>  — paced + retried; skips if already present & non-empty
fetch() {
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then skip "$(basename "$dest")"; return 0; fi
  mkdir -p "$(dirname "$dest")"
  local code
  for attempt in 1 2 3 4 5; do
    code=$(curl -fsSL -w "%{http_code}" --max-time 600 "$url" -o "$dest" || echo "000")
    if [ "$code" = "200" ] && [ -s "$dest" ]; then ok "$(basename "$dest")"; return 0; fi
    rm -f "$dest"; sleep 2
  done
  echo "  ✗ FAILED: $url (HTTP $code)"; return 1
}

info "Engine + runtime (transformers.js, ONNX Runtime, DeepFilterNet lib)"
fetch "$JSD/@huggingface/transformers@3.1.2/dist/transformers.min.js" \
      "$STATIC/vendor/transformers/transformers.min.js"
fetch "$JSD/@huggingface/transformers@3.1.2/dist/ort-wasm-simd-threaded.jsep.wasm" \
      "$STATIC/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm"
fetch "$JSD/deepfilternet3-noise-filter@1.2.1/dist/index.esm.js" \
      "$STATIC/vendor/deepfilternet3.esm.js"

info "DeepFilterNet3 model + wasm (self-hosted, ~18 MB)"
fetch "$DF_CDN/v2/pkg/df_bg.wasm" \
      "$STATIC/df3/v2/pkg/df_bg.wasm"
fetch "$DF_CDN/v2/models/DeepFilterNet3_onnx.tar.gz" \
      "$STATIC/df3/v2/models/DeepFilterNet3_onnx.tar.gz"

ROOT_FILES="config.json generation_config.json preprocessor_config.json \
tokenizer.json tokenizer_config.json vocab.json merges.txt added_tokens.json \
special_tokens_map.json normalizer.json"
ONNX_FILES="encoder_model.onnx decoder_model_merged.onnx \
encoder_model_quantized.onnx decoder_model_merged_quantized.onnx"

for model in whisper-tiny whisper-base; do
  info "Whisper model: Xenova/$model (fp32 for WebGPU + q8 for WASM)"
  base="$STATIC/models/Xenova/$model"
  for f in $ROOT_FILES; do
    sleep 1                       # pace requests so huggingface.co doesn't drop us
    fetch "$HF/Xenova/$model/resolve/main/$f" "$base/$f"
  done
  for f in $ONNX_FILES; do
    fetch "$HF/Xenova/$model/resolve/main/onnx/$f" "$base/onnx/$f"
  done
done

info "Done — all assets present. Launch with:  python -m app.main"
