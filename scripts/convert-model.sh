#!/usr/bin/env bash
#
# Convert the Slovak Whisper fine-tune to GGML and install it for pi-dictate.
#
# The extension needs a GGML model and a whisper-cli binary; neither is
# published for this checkpoint, so both are built here. Run once.
#
#   ./scripts/convert-model.sh              # q5_0, the shipped default
#   KEEP_F16=1 ./scripts/convert-model.sh   # also keep the 1.5 GiB f16 artefact
#
# Requires: git, a C++ toolchain, and uv (or a python3 with venv support).
# Downloads ~3.3 GB. Needs ~6 GB of free scratch space.

set -euo pipefail

MODEL_REPO="kinit/whisper-large-v3-turbo-sk"
MODEL_REVISION="v2.0"
MODEL_TAG="v2"          # short label used in artefact filenames
QUANT="${QUANT:-q5_0}"
WORK="${WORK:-$(mktemp -d -t pi-dictate-convert-XXXXXX)}"
PREFIX="${PREFIX:-$HOME/.local}"
MODEL_DIR="$PREFIX/share/pi-dictate"
BIN_DIR="$PREFIX/bin"
OUT_NAME="ggml-kinit-sk-${MODEL_TAG}-${QUANT}.bin"

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

log "Working directory: $WORK"
mkdir -p "$WORK" "$MODEL_DIR" "$BIN_DIR"
cd "$WORK"

log "Cloning sources"
# openai/whisper is needed only for whisper/assets/mel_filters.npz, which
# supplies the 128-bin mel filterbank this large-v3 derivative requires.
[ -d whisper ]     || git clone --depth=1 https://github.com/openai/whisper whisper
[ -d whisper.cpp ] || git clone --depth=1 https://github.com/ggml-org/whisper.cpp whisper.cpp

log "Creating conversion virtualenv"
# torch and transformers are conversion-only. The extension never needs them.
if command -v uv >/dev/null 2>&1; then
  uv venv venv
  PY="$WORK/venv/bin/python"
  uv pip install -q --python "$PY" cmake numpy transformers
  uv pip install -q --python "$PY" --index-url https://download.pytorch.org/whl/cpu torch
else
  python3 -m venv venv
  PY="$WORK/venv/bin/python"
  "$PY" -m pip install -q --upgrade pip
  "$PY" -m pip install -q cmake numpy transformers
  "$PY" -m pip install -q --index-url https://download.pytorch.org/whl/cpu torch
fi
export PATH="$WORK/venv/bin:$PATH"

log "Downloading $MODEL_REPO@$MODEL_REVISION (~3.3 GB)"
mkdir -p hf-model
base="https://huggingface.co/$MODEL_REPO/resolve/$MODEL_REVISION"
for f in config.json generation_config.json preprocessor_config.json \
         vocab.json added_tokens.json merges.txt tokenizer.json \
         tokenizer_config.json special_tokens_map.json normalizer.json; do
  [ -s "hf-model/$f" ] || curl -fsSL --retry 3 -o "hf-model/$f" "$base/$f"
done
# curl rather than huggingface_hub: it resumes, and it uses the system CA
# bundle, which matters behind a TLS-inspecting corporate proxy.
curl -fL --retry 3 -C - -o hf-model/model.safetensors "$base/model.safetensors"

log "Converting HF safetensors to GGML f16"
mkdir -p out
HF_HUB_OFFLINE=1 "$PY" whisper.cpp/models/convert-h5-to-ggml.py ./hf-model/ ./whisper ./out
mv out/ggml-model.bin "out/ggml-f16.bin"

log "Building whisper-cli (static, single binary)"
cmake -S whisper.cpp -B build -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF >/dev/null
cmake --build build --config Release -j "$(nproc)" --target whisper-quantize whisper-cli >/dev/null

log "Quantizing to $QUANT"
./build/bin/whisper-quantize "out/ggml-f16.bin" "out/$OUT_NAME" "$QUANT"

log "Installing"
install -m 0755 build/bin/whisper-cli "$BIN_DIR/whisper-cli"
install -m 0644 "out/$OUT_NAME" "$MODEL_DIR/$OUT_NAME"
if [ "${KEEP_F16:-0}" = "1" ]; then
  install -m 0644 "out/ggml-f16.bin" "$MODEL_DIR/ggml-kinit-sk-${MODEL_TAG}-f16.bin"
fi

log "Verifying"
# The loader must report the large-v3-turbo shape. Anything else means the
# conversion silently produced a model that will transcribe badly.
"$BIN_DIR/whisper-cli" -m "$MODEL_DIR/$OUT_NAME" -f whisper.cpp/samples/jfk.wav -l en -np -t 4 2>&1 \
  | grep -E 'n_vocab|n_audio_layer|n_text_layer|n_mels' || true

cat <<EOF

Done.

  binary   $BIN_DIR/whisper-cli
  model    $MODEL_DIR/$OUT_NAME

Expected loader values: n_vocab 51866, n_audio_layer 32, n_text_layer 4, n_mels 128.

Point the extension at it if you used a non-default name:
  export PI_DICTATE_MODEL_PATH=$MODEL_DIR/$OUT_NAME

Scratch directory left in place, delete when happy:
  rm -rf $WORK
EOF
