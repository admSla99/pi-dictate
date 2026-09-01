# Spec: Linux-native local dictation with whisper.cpp and optional LiteLLM remote

Status: implemented
Supersedes: current Deepgram + macOS implementation in `index.ts`
Revision 2: local backend changed from Hugging Face Transformers to whisper.cpp
Revision 3: conversion verified on real hardware; `-nt` removed after it was found to break long-form audio; `-ac` added
Revision 4: all open questions closed; artefacts built and installed; ready to implement

## Assumptions

These were used to write this spec. Correct them before implementation starts.

1. Linux is the only supported platform. macOS and Windows support is removed, not deprecated.
2. The default backend is local inference of `kinit/whisper-large-v3-turbo-sk` (revision `v2.0`) running under **whisper.cpp**.
3. The model must be **converted to GGML before first use**. See [Prerequisite: model conversion](#prerequisite-model-conversion). The extension does not convert, download, or build anything at runtime.
4. PyTorch and Transformers are needed **only once, on the conversion machine**. They are not runtime dependencies of the extension.
5. Inference runs on CPU. whisper.cpp GPU backends exist but are out of scope for the first version.
6. LiteLLM is an explicit opt-in remote backend, reached through OpenAI-compatible `POST /v1/audio/transcriptions`.
7. Transcription happens after recording stops. Live streaming transcription is dropped.
8. Audio is captured with `arecord` from `alsa-utils`, which also works through the PipeWire ALSA layer.
9. The extension keeps its current UX: `alt+m` toggle, `alt+n` cancel, focus-aware insertion, level meter.

## Objective

Make dictation work on Linux with a local Slovak speech model, so dictated audio never leaves the machine by default.

Users are Slovak-speaking pi users on Linux who dictate prompts into the pi TUI, including into dialogs and popups.

Success means: press `alt+m`, speak Slovak, press `alt+m`, and Slovak text appears in the focused input, with no cloud call unless the user configured one.

### User stories

1. As a Linux user, I press `alt+m` and dictation starts without installing SoX or any macOS tool.
2. As a Slovak speaker, I get Slovak transcription accuracy from the KInIT fine-tune rather than the multilingual base model.
3. As a privacy-conscious user, I can confirm that the default path performs no network request at all.
4. As a user with limited disk and RAM, the local model costs roughly 550 MB instead of 3.2 GB.
5. As a user on a weak machine, I can point the extension at a LiteLLM endpoint and get the same UX.
6. As a user who misspoke, I press `alt+n` and nothing is inserted.

## Prerequisite: model conversion

**Blocking.** The local backend cannot work until this is done once. The KInIT model is published only as Hugging Face Transformers safetensors; whisper.cpp reads GGML. There is no published GGML build of this checkpoint.

### Compatibility evidence

Verified against `whisper.cpp` model loader (`src/whisper.cpp:1533-1556`) and the KInIT `config.json`:

| Parameter | KInIT value | whisper.cpp handling |
|---|---|---|
| `encoder_layers` | 32 | `n_audio_layer == 32` → `MODEL_LARGE` |
| `vocab_size` | 51866 | `== 51866` → tagged `large v3`; `>= 51865` → multilingual, `<\|sk\|>` available |
| `num_mel_bins` | 128 | `mel_128.npy` present in `whisper/assets/mel_filters.npz` |
| `decoder_layers` | 4 (turbo) | no hardcoded assumption; `large-v3-turbo` is an officially listed model |
| `max_target_positions` | 448 | converter falls back to it when `max_length` is absent |
| required files | `config.json`, `vocab.json`, `added_tokens.json` | all present in the KInIT repo |

### Conversion procedure

Automated by `scripts/convert-model.sh`, which performs every step below and installs the results. The manual sequence is kept here as the reference the script implements.

```bash
./scripts/convert-model.sh    # equivalent to everything that follows
```

```bash
# 1. Sources  (installed artefacts on the reference machine:
#     ~/.local/bin/whisper-cli                                 2.9 MB, static
#     ~/.local/share/pi-dictate/ggml-kinit-sk-v2-q5_0.bin       547 MiB)
git clone https://github.com/openai/whisper                 # supplies mel_filters.npz
git clone https://github.com/ggml-org/whisper.cpp
git clone --branch v2.0 https://huggingface.co/kinit/whisper-large-v3-turbo-sk

# 2. One-time conversion dependencies (NOT extension runtime dependencies)
python3 -m venv /tmp/convert-venv && . /tmp/convert-venv/bin/activate
pip install --index-url https://download.pytorch.org/whl/cpu torch
pip install transformers numpy

# 3. HF safetensors -> GGML f16
python3 ./whisper.cpp/models/convert-h5-to-ggml.py \
  ./whisper-large-v3-turbo-sk/ ./whisper .
mv ggml-model.bin ggml-kinit-sk-v2-f16.bin

# 4. Build whisper.cpp
cd whisper.cpp && cmake -B build && cmake --build build -j --config Release

# 5. Quantize
./build/bin/quantize ../ggml-kinit-sk-v2-f16.bin ../ggml-kinit-sk-v2-q5_0.bin q5_0

# 6. Install artefacts where the extension expects them
mkdir -p ~/.local/share/pi-dictate
cp ../ggml-kinit-sk-v2-q5_0.bin ~/.local/share/pi-dictate/
cp ./build/bin/whisper-cli ~/.local/bin/
```

Expected artefact sizes, based on the equivalent official `large-v3-turbo` builds: **f16 ≈ 1.5 GiB, q5_0 ≈ 547 MiB**.

### Conversion verification results

**Executed and passed** on Ubuntu 24.04 / i7-13850HX / 28 threads / CPU only, with `transformers` 5.16.1, `torch` 2.13.0+cpu, whisper.cpp `eacbd82`.

| Check | Result |
|---|---|
| `convert-h5-to-ggml.py` exit code | 0, 5 s runtime, all 587 tensors mapped |
| f16 artefact | 1,624,555,275 B (1.51 GiB) |
| q5_0 artefact | 574,041,195 B (546.8 MiB), quantization 3.6 s |
| Loader parameters | `n_vocab = 51866`, `n_audio_layer = 32`, `n_text_layer = 4`, `n_mels = 128` |
| Slovak output | correct and fluent on all test clips |

Word error rate against SloPalSpeech reference transcripts, three clips of ~25 s each:

| Clip | Transformers fp32 | ggml f16 | ggml q5_0 |
|---|---:|---:|---:|
| s0 | 0.00 % | 0.00 % | 0.00 % |
| s1 | 10.00 % | 12.00 % | 12.00 % |
| s2 | 6.12 % | 6.12 % | 6.12 % |
| **mean** | **5.37 %** | **6.04 %** | **6.04 %** |

q5_0 versus fp32 transcript agreement: 0.00 %, 1.92 %, 0.00 % word-level difference.

**Conclusion: ship q5_0.** It is bit-for-bit as accurate as f16 here while using one third of the memory, and the whole GGML path costs 0.67 pp against fp32 — a single word on one clip.

Caveats on this measurement, stated so nobody over-reads it: three clips totalling 75 s is a small sample, and SloPalSpeech is listed in the model's own training data, so absolute WER is optimistic. The number that matters for the ship decision is the fp32-to-q5_0 delta, which is measured on identical audio and is therefore unaffected by that bias.

### Measured performance

q5_0, 8 threads, CPU only:

| Input | Wall time | Note |
|---|---:|---|
| Model load | 0.24 s | per invocation, negligible |
| 5 s clip, full context | 10.9 s | encoder always pads to a 30 s window |
| 5 s clip, `-ac 512` | 4.8 s | identical transcript |
| 8 s clip, full context | 11.9-14.5 s | |
| 8 s clip, `-ac 512` | 4.8-5.7 s | differs only in final punctuation |
| 25 s clip | 11.0-15.5 s | |
| 50 s clip | 26.5 s | two windows |

Thread scaling on a 25 s clip: 4 threads 20.2 s, 8 threads 14.9 s, 14 threads 13.9 s, 28 threads 13.8 s. Returns collapse after 8.

Peak RSS: q5_0 813 MB, f16 1.85 GB.

Two consequences drive the design below. First, the 0.24 s load time means a fresh process per dictation is free, so no daemon is needed. Second, the Whisper encoder always processes a padded 30 s window, so a 5 s dictation costs the same as a 25 s one unless `-ac` is scaled down.

## Tech Stack

| Layer | Choice |
|---|---|
| Extension runtime | TypeScript, loaded by pi via jiti |
| pi API | `@earendil-works/pi-coding-agent` 0.80.10, `@earendil-works/pi-tui` 0.80.10 |
| Node | Node 22+, built-ins only, no runtime npm dependencies |
| Audio capture | `arecord` (`alsa-utils`), 16 kHz mono S16_LE |
| Local inference | `whisper-cli` from whisper.cpp, single native binary |
| Local model | `ggml-kinit-sk-v2-q5_0.bin`, converted from `kinit/whisper-large-v3-turbo-sk@v2.0`, MIT |
| Conversion-only | Python 3.10+, `torch` (CPU wheel), `transformers`, `numpy` |
| Remote inference | LiteLLM OpenAI-compatible `/v1/audio/transcriptions` |
| Tests | `node:test` |

Model facts that constrain the implementation:

- 16 kHz mono 16-bit WAV is consumed directly. whisper.cpp decodes through miniaudio and stb_vorbis (`examples/common-whisper.cpp`), so other formats also work, but our capture already produces the native format and needs no conversion.
- GGML carries no default language. `generation_config.json`'s `language: slovak` is **lost** in conversion, and `whisper-cli` defaults to `"en"` (`examples/cli/cli.cpp:84`). `-l sk` is mandatory.
- whisper.cpp handles 30 s windowing internally, but **only when timestamps are enabled**. See [Local transcription](#local-transcription).
- The encoder cost is independent of actual speech length unless `-ac` is lowered.

## Commands

```bash
# Extension type check
npm run check

# Extension tests (test script to be added in implementation)
npm test

# One-time user setup
sudo apt install alsa-utils
# then follow "Prerequisite: model conversion" above

# Local transcription, exactly what the extension spawns (10 s recording)
whisper-cli -m ~/.local/share/pi-dictate/ggml-kinit-sk-v2-q5_0.bin \
  -f /tmp/recording.wav -l sk -np -t 8 -ac 600

# Manual capture smoke test
arecord -q -f S16_LE -r 16000 -c 1 -d 3 /tmp/dictate-smoke.wav

# Reload after editing the extension
/reload
```

## Project Structure

```
index.ts                  pi/TUI wiring, recording, lifecycle, whisper.cpp spawn, LiteLLM HTTP
scripts/convert-model.sh  one-time GGML conversion, quantization, whisper-cli build and install
test/*.test.ts            node:test unit tests for pure logic and mocked HTTP
README.md                 Linux setup, model conversion, configuration
SPEC.md                   this document
```

Compared to revision 1 of this spec, `local_transcribe.py` and `requirements-local.txt` are gone. The local backend is a process spawn, not a protocol.

No backend class hierarchy. `index.ts` selects between two functions:

```ts
transcribeLocal(wavPath, signal): Promise<string>
transcribeLiteLLM(wavPath, signal): Promise<string>
```

## Code Style

Existing style is kept: single default-exported factory, closure state, comments that explain why rather than what.

```ts
type State = "idle" | "recording" | "transcribing";

/** Build a 44-byte WAV header for finished 16 kHz mono S16_LE PCM. */
function wavHeader(pcmBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28); // byte rate
  header.writeUInt16LE(CHANNELS * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}
```

Conventions:

- Node built-ins imported with the `node:` prefix.
- Environment variables read once into a typed config object, not scattered through the code.
- Every async callback validates the session `generation` before touching shared state.
- User-facing errors go through `ctx.ui.notify`; debug output goes through `dbg()` and never contains transcripts, audio paths, or API keys.

## Testing Strategy

Tests must not call production services, run a real transcription, touch a real microphone, or modify user configuration.

| Level | Framework | Location | Covers |
|---|---|---|---|
| Unit | `node:test` | `test/*.test.ts` | RMS math, meter mapping, WAV header, text normalization and append, config parsing, state transitions, stale generation guard, whisper-cli argument construction, stdout parsing |
| Integration | `node:test` + local `http.createServer` | `test/litellm.test.ts` | multipart request shape, success, 401, 500, invalid JSON, abort |
| Integration | `node:test` + fake `whisper-cli` script | `test/local.test.ts` | success stdout, non-zero exit, missing binary, missing model file, abort via signal |

Two unit tests exist specifically to lock in the findings from conversion verification:

- the spawned argument list contains `-l` and `-ac` and never `-nt`;
- multi-line timestamped stdout is joined into one clean transcript with no `[00:00:00.000 --> ...]` residue.

The Python `unittest` suite from revision 1 is dropped along with the Python worker.

Coverage expectation: every non-trivial pure function and both error paths of each backend. No coverage threshold tooling is added.

Manual smoke checklist before release:

1. Conversion verification reproduced on the target machine.
2. 3-second recording through `arecord`.
3. Recording longer than 30 seconds transcribed in full, word count compared against a timestamped reference run.</br>
4. `alt+n` during `recording` and during `transcribing`.
5. Insertion into the main editor, `ctx.ui.input()`, and `ctx.ui.editor()`.
6. Fallback to the main editor when nothing text-capable is focused.
7. Local backend with the network interface down.
8. LiteLLM backend against a mock or test proxy.

## Configuration

Configuration stays environment-variable based.

### Shared

| Variable | Default | Meaning |
|---|---|---|
| `PI_DICTATE_BACKEND` | `local` | `local` or `litellm` |
| `PI_DICTATE_AUDIO_DEVICE` | ALSA `default` | Passed to `arecord -D` |
| `PI_DICTATE_LANGUAGE` | `sk` | Passed to `whisper-cli -l` and as LiteLLM `language` |
| `DICTATE_DEBUG` | unset | Enables lifecycle logging |

### Local backend

| Variable | Default |
|---|---|
| `PI_DICTATE_WHISPER_BIN` | `whisper-cli` (resolved on `PATH`) |
| `PI_DICTATE_MODEL_PATH` | `~/.local/share/pi-dictate/ggml-kinit-sk-v2-q5_0.bin` |
| `PI_DICTATE_THREADS` | number of available CPU cores, capped at 8; measured returns collapse past 8 |
| `PI_DICTATE_AUDIO_CONTEXT` | unset; when set, overrides the computed `-ac` value |

Revision 1 variables `PI_DICTATE_PYTHON`, `PI_DICTATE_MODEL`, `PI_DICTATE_MODEL_REVISION`, `PI_DICTATE_DEVICE`, `PI_DICTATE_DTYPE` and the `HF_*` cache variables are removed. Nothing in the runtime touches Hugging Face any more.

### LiteLLM backend

| Variable | Default |
|---|---|
| `PI_DICTATE_LITELLM_URL` | required, full endpoint URL |
| `PI_DICTATE_LITELLM_API_KEY` | optional; `Authorization` header sent only when set |
| `PI_DICTATE_LITELLM_MODEL` | `whisper-1` |

## Behaviour

### State machine

```
idle ──alt+m──> recording ──alt+m──> transcribing ──result──> idle
  ^                  │                     │
  └── alt+n / error / shutdown ────────────┘
```

The `loading` state from revision 1 is gone. whisper.cpp loads the model per invocation and there is no first-run download, so there is nothing to wait for before the microphone opens.

### Recording

```bash
arecord -q [-D "$PI_DICTATE_AUDIO_DEVICE"] -f S16_LE -r 16000 -c 1 -t raw -
```

Each chunk updates the RMS meter and is appended to a temporary file created with `mkdtemp` and owner-only permissions. On stop the recorder gets `SIGTERM`, the WAV header is written with the final sizes, and the chosen backend is invoked.

### Local transcription

```bash
whisper-cli -m <PI_DICTATE_MODEL_PATH> -f <recording.wav> \
  -l <PI_DICTATE_LANGUAGE> -np -t <PI_DICTATE_THREADS> -ac <computed>
```

Flag rationale, all verified in `examples/cli/cli.cpp` and by measurement:

- `-l` — mandatory; the CLI default is `en` and GGML carries no language default.
- `-np` — no prints, so stdout carries only transcript lines.
- `-ac` — audio context in encoder frames, computed as `clamp(ceil(seconds / 30 * 1500) + 150, 256, 1500)`. Scaling it to the actual recording length is what makes short dictations fast.
- `-nt` — **must not be used.** See below.

#### Why `-nt` is banned

`-nt` passes `<|notimestamps|>` to the decoder. With this fine-tune, which was trained with `return_timestamps: false`, that breaks whisper.cpp's multi-window seek loop and silently truncates anything past the first 30 s window.

Measured on a 50 s Slovak file, deterministic across repeated runs:

| Invocation | Words emitted |
|---|---:|
| default (timestamps on) | 134 |
| `-nt` | **83, truncated mid-sentence** |
| `-nt -mc 0` | 128 |
| `-mc 0` | 134 |

Silent truncation is the worst possible failure mode for a dictation tool: the user sees plausible text and never learns that the tail was dropped. The extension therefore keeps timestamps on and strips the prefixes itself:

```ts
// whisper-cli emits: "[00:00:00.000 --> 00:00:30.000]   text"
const TIMESTAMP_PREFIX = /^\[[\d:.]+ --> [\d:.]+\]\s*/;
const transcript = stdout
  .split("\n")
  .map((line) => line.replace(TIMESTAMP_PREFIX, "").trim())
  .filter(Boolean)
  .join(" ");
```

#### Process handling

Model load is 0.24 s, so the extension spawns a fresh `whisper-cli` per dictation and holds no daemon.

The transcript is stdout, prefix-stripped, trimmed, and whitespace-collapsed. Before spawning, the extension verifies the model file exists and reports a clear error naming the conversion prerequisite when it does not. A non-zero exit surfaces the exit code and a truncated `stderr` excerpt. Cancellation kills the process with `SIGTERM`.

### LiteLLM request

```
POST <PI_DICTATE_LITELLM_URL>
Authorization: Bearer <key>          # only when configured
Content-Type: multipart/form-data    # boundary set by FormData, never hand-written

file=<recording.wav>
model=<PI_DICTATE_LITELLM_MODEL>
language=<PI_DICTATE_LANGUAGE>
response_format=json
```

Expected response body is `{"text": "..."}`. Non-2xx surfaces the HTTP status and a truncated response excerpt.

### Keyboard handling

Global `alt+m` / `alt+n` interception uses the public `ctx.ui.onTerminalInput()`. The legacy `pi.registerShortcut` fallback from the Deepgram implementation is **removed**; it only ever fired when the main editor had focus, which the terminal-input listener already covers.

Resolving the delivery target still reads the private `tui.focusedComponent` property, obtained through a zero-height widget. This is an accepted compatibility risk: pi exposes no public API for the focused component, and dropping the read would mean losing dictation into dialogs and popups. If a future pi release breaks it, `resolveTarget()` returns `null` and delivery degrades to the main editor, which is the documented fallback rather than a crash.

### Result insertion

1. Editor-like focused component: append through `getText()` / `setText()`.
2. Typable popup: synthetic input.
3. Otherwise: append to the main pi editor through the public `ctx.ui` API.

There is no maximum recording duration. Whisper windows the audio itself, temp files cost roughly 1.9 MB per minute, and an arbitrary cap would truncate exactly the long dictation a user cared most about.

Clipboard handling is removed entirely. Text is trimmed, internal whitespace collapsed, and a single separating space added when the target already ends in a non-space character. Empty results are not inserted.

## Boundaries

**Always**

- Keep the default path offline: the local backend makes no network call whatsoever.
- Pass `-l` explicitly to `whisper-cli`; never rely on its default.
- Leave timestamps enabled and strip them in the extension. Never pass `-nt`; it silently truncates audio past 30 s with this model.
- Scale `-ac` to the recording length.
- Validate `process.platform === "linux"` before starting dictation and explain the refusal.
- Check the session `generation` in every recorder, subprocess, and HTTP callback.
- Kill the recorder and `whisper-cli` and delete the temporary audio file on success, error, cancel, and shutdown.
- Run `npm run check` and `npm test` before declaring work done.

**Ask first**

- Adding any runtime npm dependency to the extension.
- Making the extension download, convert, build, or quantize anything at runtime.
- Changing the default model, quantization level, or language.
- Introducing a second capture tool such as `pw-record` or `ffmpeg`.
- Enabling a whisper.cpp GPU backend.
- Changing the `alt+m` / `alt+n` bindings.

**Never**

- Fall back from the local backend to a remote endpoint automatically.
- Insert a partial transcript after an error or cancellation.
- Log transcripts, audio paths, or API keys.
- Send audio over plaintext HTTP to a non-loopback host.
- Write recordings into the project directory or leave them behind after a run.
- Keep Deepgram, `pbcopy`, Homebrew, or macOS branches anywhere in runtime code.
- Ship a converted `.bin` artefact inside this git repository.

## Success Criteria

1. The conversion prerequisite is documented in `README.md` with copy-pasteable commands and the verification checks.
2. With no configuration beyond a converted model at the default path, dictation transcribes Slovak locally.
3. The local backend completes successfully with the network interface down.
4. `rg -i 'deepgram|pbcopy|brew|darwin|torch|transformers' index.ts` returns no runtime matches.
5. Audio is captured as 16 kHz mono S16_LE through `arecord` and consumed directly by `whisper-cli` with no format conversion.
6. The spawned command always contains `-l` and `-ac`, and never contains `-nt`.
7. A missing `whisper-cli` binary or missing model file produces an error that names the conversion prerequisite.
8. A 50-second recording yields the same word count as a timestamped reference run, proving no silent truncation.
9. A 5-second dictation completes in under 6 seconds on the reference CPU.
10. `PI_DICTATE_BACKEND=litellm` sends the recording to the configured endpoint and inserts the returned text.
11. A local backend failure never triggers a remote request.
12. Cancel and error paths insert nothing.
13. After cancel or shutdown no recorder process, `whisper-cli` process, or temporary file remains.
14. `alt+m` and `alt+n` still work while a dialog or popup holds focus.
15. `npm run check` and `npm test` pass offline.

## Resolved Questions

All questions are closed. This specification has been implemented.

| Question | Decision |
|---|---|
| Does the conversion work, and is q5_0 good enough? | Yes to both, measured above. Ship q5_0. |
| Is a `whisper-server` daemon needed? | No. Model load is 0.24 s per invocation. |
| Private `tui.focusedComponent` read | Accepted risk. Popup support is worth it; failure degrades to the main editor. |
| Ship a conversion script? | Yes, `scripts/convert-model.sh`. |
| Is the `-ac` margin of 150 frames right? | Yes, keep it. |
| Keep the legacy `pi.registerShortcut` fallback? | No, drop it. |
| Maximum recording duration cap? | No cap. |
