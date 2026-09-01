# pi-dictate

Linux voice dictation for [pi](https://github.com/badlogic/pi-mono), with local Slovak inference through whisper.cpp and an optional LiteLLM backend.

- `alt+m`: start recording; press again to stop and transcribe
- `alt+n`: cancel recording or transcription without inserting text
- Audio: 16 kHz mono S16_LE through `arecord`
- Default backend: local `kinit/whisper-large-v3-turbo-sk@v2.0`, quantized to q5_0
- Delivery: appends to the focused editor or typable popup, falling back to pi's main editor

## Requirements

- Linux
- Node.js 22 or newer and pi
- `alsa-utils`
- For one-time model conversion: `git`, `curl`, a C++ toolchain, and either `uv` or Python 3 with `venv`

On Ubuntu or Debian:

```bash
sudo apt install alsa-utils build-essential git curl python3-venv
```

## Install

```bash
pi install git:github.com/amosblomqvist/pi-dictate
```

Run `/reload` in pi after installation or after changing configuration.

## Local model setup

The default backend needs `whisper-cli` and a converted GGML model. Clone this repository and run the included one-time conversion script:

```bash
git clone https://github.com/amosblomqvist/pi-dictate.git
cd pi-dictate
./scripts/convert-model.sh
```

The script downloads about 3.3 GB, uses about 6 GB of scratch space, builds whisper.cpp, converts the KInIT v2.0 checkpoint, quantizes it, and installs:

```text
~/.local/bin/whisper-cli
~/.local/share/pi-dictate/ggml-kinit-sk-v2-q5_0.bin
```

The installed q5_0 model is 574,041,195 bytes (546.8 MiB). During verification, the script prints loader values that should be:

```text
n_vocab 51866
n_audio_layer 32
n_text_layer 4
n_mels 128
```

Ensure `~/.local/bin` is on `PATH`, then test audio capture:

```bash
arecord -q -f S16_LE -r 16000 -c 1 -d 3 /tmp/dictate-smoke.wav
```

The conversion dependencies are not needed while using the extension.

## Usage

1. Press `alt+m`; the status row shows a red dot and live microphone meter.
2. Speak.
3. Press `alt+m` again; the status changes to `transcribing…`.
4. The transcript is appended to the focused text target. If none is available, it is appended to pi's main editor and a warning is shown.

Focus is resolved when transcription finishes. In a selector or other opaque dialog, focus its free-text field before dictating so synthetic input reaches that field.

Local transcription runs after recording stops and makes no network request. On the reference i7-13850HX CPU with q5_0 and 8 threads, a 5-second clip took 4.8 seconds with the scaled audio context; a 25-second clip took 11.0–15.5 seconds.

## Configuration

Environment variables are read when the extension loads. Set them before starting pi, then use `/reload` after changes.

### Shared

| Variable | Default | Purpose |
|---|---|---|
| `PI_DICTATE_BACKEND` | `local` | `local` or `litellm` |
| `PI_DICTATE_AUDIO_DEVICE` | ALSA `default` | Device passed to `arecord -D`; the default omits `-D` |
| `PI_DICTATE_LANGUAGE` | `sk` | Language passed to local and remote transcription |
| `DICTATE_DEBUG` | unset | Write lifecycle events to `/tmp/dictate-debug.log` when set |

### Local backend

| Variable | Default | Purpose |
|---|---|---|
| `PI_DICTATE_WHISPER_BIN` | `whisper-cli` | Binary name or path |
| `PI_DICTATE_MODEL_PATH` | `~/.local/share/pi-dictate/ggml-kinit-sk-v2-q5_0.bin` | Converted GGML model |
| `PI_DICTATE_THREADS` | available CPU cores, capped at 8 | Positive worker-thread count |
| `PI_DICTATE_AUDIO_CONTEXT` | computed from recording duration | Positive override for whisper.cpp `-ac` |

The computed audio context is `clamp(ceil(seconds / 30 × 1500) + 150, 256, 1500)`. Timestamps remain enabled so recordings longer than 30 seconds are processed in full; timestamp prefixes are removed before insertion.

### LiteLLM backend

| Variable | Default | Purpose |
|---|---|---|
| `PI_DICTATE_LITELLM_URL` | required | Full OpenAI-compatible `/v1/audio/transcriptions` endpoint |
| `PI_DICTATE_LITELLM_API_KEY` | unset | Optional bearer token |
| `PI_DICTATE_LITELLM_MODEL` | `whisper-1` | Model sent in the multipart request |

Example:

```bash
export PI_DICTATE_BACKEND=litellm
export PI_DICTATE_LITELLM_URL=https://llm.example.com/v1/audio/transcriptions
export PI_DICTATE_LITELLM_API_KEY=your-token
pi
```

Plaintext HTTP is accepted only for loopback endpoints. Backend selection is explicit: a local failure does not send audio remotely.

## Troubleshooting

- **`arecord` not found:** install `alsa-utils`.
- **No microphone level:** run the capture command above and set `PI_DICTATE_AUDIO_DEVICE` if ALSA's default is not the intended input.
- **`whisper-cli` or model not found:** run `scripts/convert-model.sh` and check `PATH` plus `PI_DICTATE_MODEL_PATH`.
- **Shortcuts in tmux:** the default `alt` bindings use terminal sequences that tmux forwards without extended-key configuration.
- **Text went to the main editor:** focus a text field before transcription finishes.

## License

MIT
