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
WHISPER_CPP_REF="v1.9.3"
WHISPER_CPP_COMMIT="371b5a7561823ab2bb32142d2751e35e7534727b"
WHISPER_CPP_VERSION="1.9.3"

mkdir -p "$BIN_DIR" "$MODEL_DIR"

binary_is_current() {
  [ -x "$BIN_DIR/whisper-cli" ] &&
    "$BIN_DIR/whisper-cli" --version 2>&1 | grep -Fxq "whisper.cpp version: $WHISPER_CPP_VERSION"
}

if [ "${FORCE_REINSTALL:-0}" = "1" ] || ! binary_is_current; then
  WORK="$(mktemp -d -t pi-dictate-install-XXXXXX)"
  trap 'rm -rf "$WORK"' EXIT
  git clone --branch "$WHISPER_CPP_REF" --depth=1 https://github.com/ggml-org/whisper.cpp "$WORK/whisper.cpp"
  [ "$(git -C "$WORK/whisper.cpp" rev-parse HEAD)" = "$WHISPER_CPP_COMMIT" ] || {
    echo "Unexpected whisper.cpp commit" >&2
    exit 1
  }
  cmake -S "$WORK/whisper.cpp" -B "$WORK/build" -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_IS_DEV=OFF -DWHISPER_BUILD_TESTS=OFF
  cmake --build "$WORK/build" --config Release -j "$(nproc)" --target whisper-cli
  install -m 0755 "$WORK/build/bin/whisper-cli" "$BIN_DIR/whisper-cli"
fi

model_is_valid() {
  [ -f "$1" ] && echo "$MODEL_SHA1  $1" | sha1sum --check --status 2>/dev/null
}

if ! model_is_valid "$MODEL_PATH"; then
  rm -f "$MODEL_PATH"
  CURL=(curl -fL --retry 5 --retry-all-errors)
  status=0
  "${CURL[@]}" --continue-at - -o "$MODEL_PATH.part" "$MODEL_URL" || status=$?
  if [ "$status" -eq 33 ]; then
    rm -f "$MODEL_PATH.part"
    "${CURL[@]}" -o "$MODEL_PATH.part" "$MODEL_URL"
  elif [ "$status" -ne 0 ]; then
    exit "$status"
  fi
  if ! model_is_valid "$MODEL_PATH.part"; then
    rm -f "$MODEL_PATH.part"
    "${CURL[@]}" -o "$MODEL_PATH.part" "$MODEL_URL"
    model_is_valid "$MODEL_PATH.part" || {
      rm -f "$MODEL_PATH.part"
      echo "Model checksum verification failed" >&2
      exit 1
    }
  fi
  mv "$MODEL_PATH.part" "$MODEL_PATH"
fi

cat <<EOF
Installed:
  binary  $BIN_DIR/whisper-cli
  model   $MODEL_PATH

Add $BIN_DIR to PATH before starting pi.
Use FORCE_REINSTALL=1 to rebuild whisper-cli.
EOF
