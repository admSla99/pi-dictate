#!/usr/bin/env bash
# Install whisper-cli and the multilingual large-v3-turbo q5_0 model.

set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
MODEL_DIR="$PREFIX/share/pi-dictate"
MODEL_NAME="ggml-openai-large-v3-turbo-q5_0.bin"
MODEL_PATH="$MODEL_DIR/$MODEL_NAME"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
MODEL_SHA1="e050f7970618a659205450ad97eb95a18d69c9ee"

mkdir -p "$BIN_DIR" "$MODEL_DIR"

if [ ! -x "$BIN_DIR/whisper-cli" ]; then
  WORK="$(mktemp -d -t pi-dictate-install-XXXXXX)"
  trap 'rm -rf "$WORK"' EXIT
  git clone --depth=1 https://github.com/ggml-org/whisper.cpp "$WORK/whisper.cpp"
  cmake -S "$WORK/whisper.cpp" -B "$WORK/build" -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF
  cmake --build "$WORK/build" --config Release -j "$(nproc)" --target whisper-cli
  install -m 0755 "$WORK/build/bin/whisper-cli" "$BIN_DIR/whisper-cli"
fi

if ! echo "$MODEL_SHA1  $MODEL_PATH" | sha1sum --check --status 2>/dev/null; then
  rm -f "$MODEL_PATH"
  curl -fL --retry 5 --retry-all-errors -o "$MODEL_PATH.part" "$MODEL_URL"
  echo "$MODEL_SHA1  $MODEL_PATH.part" | sha1sum --check
  mv "$MODEL_PATH.part" "$MODEL_PATH"
fi

cat <<EOF
Installed:
  binary  $BIN_DIR/whisper-cli
  model   $MODEL_PATH

Add $BIN_DIR to PATH before starting pi.
EOF
