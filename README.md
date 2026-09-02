# pi-dictate

Linux voice dictation for [pi](https://github.com/badlogic/pi-mono), with local multilingual inference through whisper.cpp, and optional LiteLLM or Deepgram remote backends.

This is a Linux-only fork of [amosblomqvist/pi-dictate](https://github.com/amosblomqvist/pi-dictate), focused on local whisper.cpp inference with optional remote backends.

- `alt+m`: start recording; press again to stop and transcribe
- `alt+n`: cancel recording or transcription without inserting text
- Audio: 16 kHz mono S16_LE through `arecord`
- Backends: `local` (default, offline, record-then-transcribe), `litellm` (remote, record-then-transcribe), `deepgram` (remote, live streaming while you speak) — selection is explicit and there is no automatic fallback between them
- Delivery: appends to the focused editor or typable popup, falling back to pi's main editor

## Requirements

- Linux
- Node.js 22 or newer and pi
- `alsa-utils`
- For one-time whisper.cpp setup: `git`, `curl`, CMake, and a C++ toolchain

On Ubuntu or Debian:

```bash
sudo apt install alsa-utils build-essential cmake git curl
```

## Install

```bash
pi install git:github.com/admSla99/pi-dictate
```

Run `/reload` in pi after installation or after changing configuration.

## Local model setup

The default backend needs `whisper-cli` and the official pre-converted GGML model. Clone this repository and run the included one-time installer:

```bash
git clone https://github.com/admSla99/pi-dictate.git
cd pi-dictate
./scripts/install-whisper.sh
```

The script installs the pinned whisper.cpp v1.9.3 CLI when it is missing or outdated, downloads the checksum-verified q5_0 model, and installs:

```text
~/.local/bin/whisper-cli
~/.local/share/pi-dictate/ggml-openai-large-v3-turbo-q5_0.bin
```

The model is 574,041,195 bytes (546.8 MiB). Ensure `~/.local/bin` is on `PATH`, then test audio capture:

```bash
arecord -q -f S16_LE -r 16000 -c 1 -d 3 /tmp/dictate-smoke.wav
```

The build dependencies are not needed while using the extension.

## Usage

1. Press `alt+m`; the status row shows a red dot and live microphone meter.
2. Speak.
3. Press `alt+m` again; the status changes to `transcribing…`.
4. The transcript is appended to the focused text target. If none is available, it is appended to pi's main editor and a warning is shown.

Focus is resolved when transcription finishes. In a selector or other opaque dialog, focus its free-text field before dictating so synthetic input reaches that field.

Local transcription runs after recording stops, automatically detects the spoken language, and makes no network request.

With `PI_DICTATE_BACKEND=deepgram`, the status row shows a connecting indicator before the microphone opens, audio streams to Deepgram in real time while you speak, and only the finalized transcript is inserted after the second `alt+m`; interim (partial) results are never shown or inserted.

## Configuration

Environment variables are read when the extension loads. Set them before starting pi, then use `/reload` after changes.

### Shared

| Variable | Default | Purpose |
|---|---|---|
| `PI_DICTATE_BACKEND` | `local` | `local`, `litellm`, or `deepgram` |
| `PI_DICTATE_AUDIO_DEVICE` | ALSA `default` | Device passed to `arecord -D`; the default omits `-D` |
| `PI_DICTATE_LANGUAGE` | `auto` | Language for local transcription; `auto` also lets LiteLLM detect it. Must be set to an explicit code (e.g. `sk`) for the `deepgram` backend, which rejects `auto` |
| `DICTATE_DEBUG` | unset | Write lifecycle events to `/tmp/dictate-debug.log` when set |

### Local backend

| Variable | Default | Purpose |
|---|---|---|
| `PI_DICTATE_WHISPER_BIN` | `whisper-cli` | Binary name or path |
| `PI_DICTATE_MODEL_PATH` | `~/.local/share/pi-dictate/ggml-openai-large-v3-turbo-q5_0.bin` | Local GGML model |
| `PI_DICTATE_THREADS` | available CPU cores, capped at 8 | Positive worker-thread count |
| `PI_DICTATE_AUDIO_CONTEXT` | `1500` | Positive override for whisper.cpp `-ac` |

The full encoder context keeps multilingual decoding stable, including for short recordings. Timestamps remain enabled so recordings longer than 30 seconds are processed in full; timestamp prefixes are removed before insertion.

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

### Deepgram backend

| Variable | Default | Purpose |
|---|---|---|
| `DEEPGRAM_API_KEY` | required | Deepgram API key, sent only through the WebSocket `token` subprotocol; never placed in the URL, logged, or included in error messages |
| `PI_DICTATE_LANGUAGE` | must be set explicitly | e.g. `sk`; `auto` is not a Deepgram language value, so an explicit supported code must be chosen |

Example:

```bash
export PI_DICTATE_BACKEND=deepgram
export DEEPGRAM_API_KEY=dg_xxxxxxxxxxxxxxxx
export PI_DICTATE_LANGUAGE=sk
pi
```

This is the only backend that transmits audio off the machine while you are still speaking: raw PCM streams to Deepgram's live-transcription endpoint (`wss://api.deepgram.com/v1/listen`, model `nova-3`) in real time. Only the finalized, punctuated transcript is inserted, and only after the second `alt+m`; interim results are never delivered. Deepgram is used only when explicitly selected with `PI_DICTATE_BACKEND=deepgram` — `local` remains the default, and no backend automatically falls back to another on failure.

## Troubleshooting

- **`arecord` not found:** install `alsa-utils`.
- **No microphone level:** run the capture command above and set `PI_DICTATE_AUDIO_DEVICE` if ALSA's default is not the intended input.
- **`whisper-cli` or model not found:** run `scripts/install-whisper.sh` and check `PATH` plus `PI_DICTATE_MODEL_PATH`. Use `FORCE_REINSTALL=1 ./scripts/install-whisper.sh` to rebuild the CLI.
- **Shortcuts in tmux:** the default `alt` bindings use terminal sequences that tmux forwards without extended-key configuration.
- **Text went to the main editor:** focus a text field before transcription finishes.
- **`DEEPGRAM_API_KEY is required...`:** set a Deepgram API key before selecting `PI_DICTATE_BACKEND=deepgram`.
- **Deepgram rejects `PI_DICTATE_LANGUAGE=auto`:** `auto` is not a Deepgram language value; set an explicit supported code such as `sk`.

## License

MIT
