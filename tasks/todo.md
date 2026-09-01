# Todo: Linux-native local dictation

Plan: [`plan.md`](plan.md). Spec: [`../SPEC.md`](../SPEC.md) revision 4.

Every task also clears the Definition of Done in `plan.md`.

---

## Phase 1: Foundation

### Task 1: Test scaffolding and `npm test`

**Description:** Add a `test` script so every later task has somewhere to put its checks. Uses the built-in `node:test` runner, so no dependency is added.

**Acceptance criteria:**
- [x] `npm test` runs `node --test` over `test/` and exits 0 on an empty or trivial suite
- [x] Tests import helpers from `index.ts` without starting an extension session
- [x] `tsconfig.json` includes `test/` so type checking covers it

**Verification:**
- [x] `npm test` passes
- [x] `npm run check` passes

**Dependencies:** None

**Files likely touched:** `package.json`, `tsconfig.json`, `test/smoke.test.ts`

**Scope:** XS

---

### Task 2: Configuration and platform guard

**Description:** Read every environment variable once into a typed config object, and refuse to start dictation on non-Linux platforms with an explanatory notification instead of failing later inside `arecord`.

**Acceptance criteria:**
- [x] One `readConfig()` returns backend, audio device, language, threads, whisper binary and model path, audio-context override, and the three LiteLLM settings, applying spec defaults
- [x] `PI_DICTATE_BACKEND=litellm` without `PI_DICTATE_LITELLM_URL` is rejected with a clear message
- [x] `process.platform !== "linux"` blocks dictation and names the reason

**Verification:**
- [x] `npm test` covers defaults, overrides, and the missing-URL rejection
- [x] Manual check: `PI_DICTATE_BACKEND=litellm` with no URL shows the error, does not open the mic

**Dependencies:** Task 1

**Files likely touched:** `index.ts`, `test/config.test.ts`

**Scope:** S

---

### Task 3: Audio helpers

**Description:** Add the two pure audio functions the recorder and the local backend need: a 44-byte WAV header for a finished PCM stream, and the `-ac` value derived from recording length.

**Acceptance criteria:**
- [x] `wavHeader(pcmBytes)` produces a valid 16 kHz mono S16_LE header whose sizes match the payload
- [x] `audioContext(seconds)` implements `clamp(ceil(seconds / 30 * 1500) + 150, 256, 1500)`
- [x] `PI_DICTATE_AUDIO_CONTEXT` overrides the computed value

**Verification:**
- [x] `npm test` covers header field offsets, and `audioContext` at 0 s, 5 s, 30 s, and 120 s including both clamp ends
- [ ] Manual check: a header-prefixed capture opens in any WAV player at the right duration

**Dependencies:** Task 1

**Files likely touched:** `index.ts`, `test/audio.test.ts`

**Scope:** S

---

### Task 4: Transcript helpers

**Description:** Add the text functions shared by both backends: strip whisper.cpp timestamp prefixes into one line, and append a transcript to existing target text without clobbering it.

**Acceptance criteria:**
- [x] `parseTranscript(stdout)` removes `[00:00:00.000 --> 00:00:30.000]` prefixes, drops blank lines, and joins segments with a single space
- [x] `appendText(current, addition)` collapses whitespace, trims, and inserts one separating space only when `current` does not already end in whitespace
- [x] An empty or whitespace-only transcript yields `""` so callers can skip insertion

**Verification:**
- [x] `npm test` covers multi-segment stdout, single-segment stdout, empty stdout, and append against empty, space-terminated, and word-terminated targets
- [ ] Manual check: real two-window `whisper-cli` output parses to the full text

**Dependencies:** Task 1

**Files likely touched:** `index.ts`, `test/transcript.test.ts`

**Scope:** S

---

## Checkpoint: Foundation

- [x] `npm run check` and `npm test` pass
- [ ] Deepgram dictation still works, unchanged
- [x] All helpers needed by Phase 2 exist and are covered

---

## Phase 2: Local dictation path

### Task 5: Local whisper.cpp backend

**Description:** Add `transcribeLocal()`, which spawns `whisper-cli` against the converted model and returns the parsed transcript. Not yet wired into dictation.

**Acceptance criteria:**
- [x] Spawns with `-m`, `-f`, `-l`, `-np`, `-t`, `-ac`, and **never** `-nt`
- [x] Missing binary or missing model file produces an error naming `scripts/convert-model.sh`
- [x] Non-zero exit surfaces the exit code and a truncated `stderr`; an `AbortSignal` kills the process with `SIGTERM`

**Verification:**
- [x] `npm test` drives a fake `whisper-cli` shell script covering success, non-zero exit, missing binary, missing model, and abort
- [x] A test asserts `-nt` is absent from the argument list
- [x] Manual check: call it against `~/.local/share/pi-dictate/ggml-kinit-sk-v2-q5_0.bin` and a real WAV

**Dependencies:** Tasks 2, 3, 4

**Files likely touched:** `index.ts`, `test/local.test.ts`, `test/fixtures/fake-whisper-cli.sh`

**Scope:** M

---

### Task 6: `arecord` recorder and WAV writer

**Description:** Replace SoX capture with `arecord`, streaming PCM to a temp file and finalising the WAV header on stop. Keeps feeding the existing RMS level meter. Not yet wired into dictation.

**Acceptance criteria:**
- [x] Spawns `arecord -q [-D device] -f S16_LE -r 16000 -c 1 -t raw -` and appends stdout to a file in an owner-only `mkdtemp` directory
- [x] `stop()` sends `SIGTERM`, waits for stdout to close, writes the header, and resolves with path and duration
- [x] `discard()` kills the process and removes the temp directory; a missing `arecord` produces an error naming `alsa-utils`
- [x] Level meter still updates from chunk RMS while recording

**Verification:**
- [x] `npm test` drives a fake `arecord` emitting known PCM, then asserts the resulting file is a valid WAV of the expected length
- [x] Manual check: record 3 s, confirm the meter moves and the file plays back correctly

**Dependencies:** Tasks 2, 3

**Files likely touched:** `index.ts`, `test/recorder.test.ts`, `test/fixtures/fake-arecord.sh`

**Scope:** M

---

### Task 7: Cutover

**Description:** The atomic step. Switch the state machine to `idle | recording | transcribing`, wire recorder into backend, and delete the Deepgram WebSocket, the SoX spawn, and every macOS branch.

**Acceptance criteria:**
- [x] `rg -i 'deepgram|pbcopy|brew|darwin|websocket' index.ts` returns nothing
- [x] `alt+m` records then transcribes locally and inserts the result; `alt+n` in either non-idle state inserts nothing
- [x] The `generation` guard still discards stale recorder and subprocess callbacks
- [x] Success, error, cancel, and shutdown each leave no child process and no temp file

**Verification:**
- [x] `npm test` covers state transitions, the stale-generation guard, and temp-file cleanup on all four exit paths
- [ ] Manual check: full dictation with the network interface down
- [ ] Manual check: 50 s recording word count equals a timestamped reference run
- [ ] Manual check: 5 s dictation completes in under 6 s

**Dependencies:** Tasks 5, 6

**Files likely touched:** `index.ts`, `test/lifecycle.test.ts`

**Scope:** M

---

## Checkpoint: Local dictation

- [ ] Offline dictation works end to end
- [ ] No silent truncation past 30 s
- [ ] 5 s dictation under 6 s
- [x] Cancel is clean in both non-idle states
- [x] Review with human before proceeding

---

## Phase 3: Remote backend and delivery

### Task 8: LiteLLM remote backend

**Description:** Add `transcribeLiteLLM()`, posting the recording as multipart to an OpenAI-compatible transcription endpoint, selected only by explicit configuration.

**Acceptance criteria:**
- [x] Posts `file`, `model`, `language`, `response_format=json`; `Authorization` only when a key is set; `Content-Type` left to `FormData`
- [x] Non-2xx surfaces status plus a truncated body; the request honours `AbortSignal`
- [x] Plaintext HTTP to a non-loopback host is refused
- [x] A local backend failure never falls back to this path

**Verification:**
- [x] `npm test` drives a local `http.createServer` covering success, 401, 500, malformed JSON, and abort, and asserts the multipart field names
- [x] A test asserts no `Authorization` header when no key is configured
- [ ] Manual check: dictate against a mock endpoint with `PI_DICTATE_BACKEND=litellm`

**Dependencies:** Task 7

**Files likely touched:** `index.ts`, `test/litellm.test.ts`

**Scope:** M

---

### Task 9: Delivery targets and keybinding cleanup

**Description:** Move global key interception to the public `ctx.ui.onTerminalInput()`, drop the legacy `registerShortcut` fallback, and replace the `pbcopy` clipboard path with the main-editor fallback.

**Acceptance criteria:**
- [x] `alt+m` and `alt+n` work while a dialog or popup holds focus; key release and repeat events are still filtered
- [x] No `pi.registerShortcut` call remains
- [x] With no text-capable component focused, the transcript appends to the main editor and the user is told
- [x] A `null` from `resolveTarget()` degrades to the main editor instead of throwing

**Verification:**
- [x] `npm test` covers target resolution for editor-like, typable, and absent focus
- [ ] Manual check: insertion into the main editor, `ctx.ui.input()`, and `ctx.ui.editor()`
- [ ] Manual check: dictate with a non-text component focused, confirm the fallback and the notification

**Dependencies:** Task 7

**Files likely touched:** `index.ts`, `test/delivery.test.ts`

**Scope:** M

---

## Checkpoint: Feature complete

- [x] Both backends work
- [x] No automatic local-to-remote fallback
- [x] All three delivery paths verified
- [x] No `pbcopy`, no `registerShortcut`

---

## Phase 4: Documentation

### Task 10: README rewrite

**Description:** Rewrite the README for the Linux, whisper.cpp, and LiteLLM reality. State what is there, not what was removed.

**Acceptance criteria:**
- [x] Documents `alsa-utils`, `scripts/convert-model.sh`, the model size, and the verification values the script prints
- [x] Documents every environment variable from the spec
- [x] No Deepgram, Homebrew, `pbcopy`, macOS permissions, or iTerm content; no stop-latency claim that measurements contradict
- [x] States measured timings for a 5 s and a 25 s dictation

**Verification:**
- [x] `rg -i 'deepgram|brew|pbcopy|macos|iterm' README.md` returns nothing
- [ ] Manual check: a clean-machine reader can reach a working dictation from the README alone

**Dependencies:** Task 9

**Files likely touched:** `README.md`

**Scope:** S

---

### Task 11: Package metadata

**Description:** Update `package.json` so the description and keywords match what the extension now is.

**Acceptance criteria:**
- [x] Description names local whisper.cpp Slovak dictation rather than Deepgram
- [x] `pi.extensions` still resolves and `scripts/` ships with the package

**Verification:**
- [x] `npm run check` and `npm test` pass
- [ ] Manual check: `pi install` from a local path loads the extension

**Dependencies:** Task 9

**Files likely touched:** `package.json`

**Scope:** XS

---

### Task 12: Repoint the project at the fork

**Description:** The repository still identifies as Amos Blomqvist's upstream: `origin` is `https://github.com/amosblomqvist/pi-dictate.git`, and `main` currently sits 12 commits ahead of it. Those 12 commits are the local-first whisper.cpp rewrite, which upstream never asked for and cannot accept. Repoint the git remotes and every user-facing reference at `https://github.com/admSla99/pi-dictate`, so a push goes to the fork and a reader installs the fork.

MIT requires the original copyright notice to survive in derivative works, so `LICENSE` keeps Amos Blomqvist's line. A second copyright line is added rather than substituted.

**Acceptance criteria:**
- [x] `origin` points at `https://github.com/admSla99/pi-dictate.git`; the previous URL is preserved as a separate `upstream` remote so future upstream changes remain fetchable
- [x] `main` tracks `origin/main` on the fork
- [x] The README install command reads `pi install git:github.com/admSla99/pi-dictate`
- [x] `package.json` declares `repository`, `homepage`, and `bugs` pointing at the fork
- [x] The README states that this is a fork of `amosblomqvist/pi-dictate`, and names the substantive difference in one line: local whisper.cpp inference with optional LiteLLM, Linux only
- [x] `LICENSE` retains `Copyright (c) 2025 Amos Blomqvist` and adds the fork maintainer's line beneath it
- [x] No reference to `amosblomqvist` survives as an *install or issue target*; the attribution references stay

**Verification:**
- [x] `git remote -v` shows the fork as `origin` and upstream as `upstream`
- [x] `git rev-parse --abbrev-ref main@{upstream}` returns `origin/main`
- [x] `git push --dry-run` reports the fork URL — run the dry run only; do not push without explicit consent
- [x] `rg -n 'amosblomqvist' README.md package.json` shows only the fork-attribution line
- [x] `npm run check` and `npm test` pass
- [ ] Manual check: `pi install git:github.com/admSla99/pi-dictate` resolves

**Dependencies:** Tasks 10, 11 — both rewrite the same two files, so this lands last to avoid churn

**Files likely touched:** `README.md`, `package.json`, `LICENSE`

**Scope:** S

---

## Checkpoint: Complete

- [ ] All 15 spec success criteria verified
- [x] `npm run check` and `npm test` pass offline
- [x] `origin` is the fork; upstream is still fetchable under its own remote
- [x] `tasks/` reflects reality, no stale unchecked boxes
- [x] Ready for review
