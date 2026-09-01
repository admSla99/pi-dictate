# Spec: Opt-in Deepgram streaming backend

Status: approved; implemented in `index.ts` per this contract. Manual acceptance testing with a real, dedicated non-production Deepgram API key is pending (see Success Criterion 8).

This feature spec extends [`SPEC.md`](SPEC.md). It supersedes only the clauses that prohibit Deepgram and require every transcription to start after recording stops. All other current project constraints remain in force.

## Assumptions

1. The extension remains Linux-only and captures audio with `arecord`.
2. `local` remains the default backend; `litellm` remains supported.
3. Deepgram is selected only with `PI_DICTATE_BACKEND=deepgram`; there is no automatic remote fallback.
4. Deepgram receives audio in real time over WebSocket and inserts only finalized text after the user stops recording.
5. The implementation uses Node 22's native `WebSocket` and adds no runtime dependency.
6. The original upstream's SoX, macOS, `pbcopy`, and legacy shortcut behavior are outside this feature.

## Objective

Add Deepgram as a third transcription backend while preserving the current dictation UX and offline-by-default behavior.

A user with `PI_DICTATE_BACKEND=deepgram` and `DEEPGRAM_API_KEY` set can press `alt+m`, stream microphone audio to Deepgram while speaking, press `alt+m` again, and receive the finalized transcript in the currently focused input.

## Tech Stack

- TypeScript loaded by pi
- Node.js 22+ built-ins, including native `WebSocket`
- `arecord` producing 16 kHz, mono, signed 16-bit little-endian PCM
- Deepgram live transcription endpoint: `wss://api.deepgram.com/v1/listen`
- Deepgram Nova-3 with final results, punctuation, smart formatting, and 300 ms endpointing
- `node:test` with injected recorder and WebSocket fakes

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_DICTATE_BACKEND` | `local` | Accepts `local`, `litellm`, or `deepgram` |
| `DEEPGRAM_API_KEY` | none | Required only when the selected backend is `deepgram` |
| `PI_DICTATE_LANGUAGE` | `auto` globally | Must be set explicitly for Deepgram, for example `sk`; `auto` is rejected for this backend |

The API key is passed through the upstream-compatible WebSocket subprotocol `['token', apiKey]` and is never logged. The endpoint uses fixed, reviewed parameters: `model=nova-3`, `encoding=linear16`, `sample_rate=16000`, `channels=1`, `interim_results=false`, `smart_format=true`, `punctuate=true`, and `endpointing=300`. The configured language is sent as the `language` parameter.

## Behaviour

For the Deepgram backend, the lifecycle is:

```text
idle ──alt+m──> connecting ──socket open──> recording
  ^                  │                         │
  │                  └── error/cancel ─────────┤
  │                                            │
  └── result/error/cancel <── finalizing <──alt+m
```

1. Open and authenticate the Deepgram WebSocket before starting the microphone, so opening audio is not lost.
2. Start the existing `arecord` recorder and forward every raw PCM chunk both to the current recording pipeline and to the open WebSocket.
3. Collect non-empty transcript segments only from final Deepgram `Results` messages. Interim text is never inserted.
4. On stop, stop the recorder first, send `{"type":"CloseStream"}`, and wait up to three seconds for final results and normal socket closure.
5. Deliver the normalized final transcript through the existing focus-aware `deliver()` path.
6. On connection failure, protocol error, timeout, cancellation, or shutdown, close the socket, stop the recorder, delete the temporary WAV, and insert no text.
7. Every asynchronous recorder and WebSocket callback checks the current session generation before changing state.

Local and LiteLLM continue to use the existing record-then-transcribe lifecycle.

## Project Structure

```text
index.ts                    configuration, recorder, Deepgram session, lifecycle wiring
test/deepgram.test.ts       Deepgram protocol and message-handling tests
test/config.test.ts         backend and API-key validation
test/recorder.test.ts       raw PCM forwarding tests
test/lifecycle.test.ts      backend selection, stop, cancel, shutdown, and race tests
README.md                   Deepgram setup and privacy documentation
DEEPGRAM_SPEC.md            this feature contract
```

## Code Style

Deepgram transport is represented by a small injected interface so lifecycle tests do not contact production services:

```ts
interface DeepgramSession {
  ready: Promise<void>;
  sendAudio(chunk: Buffer): void;
  finish(): Promise<string>;
  abort(): Promise<void>;
}
```

Keep the current single-file implementation style, typed configuration, actionable user errors, and generation checks around asynchronous callbacks.

## Commands

```bash
npm run check
npm test

PI_DICTATE_BACKEND=deepgram \
DEEPGRAM_API_KEY=dg_xxxxxxxxxxxxxxxx \
pi
```

## Testing Strategy

Automated tests use `node:test` and injected fakes; they never call Deepgram or access a real microphone.

Tests cover:

- configuration defaults, explicit backend selection, and missing API key;
- WebSocket URL, authentication, PCM frames, final-result parsing, `CloseStream`, malformed messages, server errors, and timeout;
- stop before connection completes, cancel while recording/finalizing, shutdown, and stale socket events;
- exactly-once insertion of finalized text and no insertion on errors or cancellation;
- unchanged local and LiteLLM backend behavior.

A manual smoke test with a dedicated non-production Deepgram key verifies real streaming, finalization latency, cancellation, and cleanup.

## Boundaries

### Always

- Keep `local` as the default and require explicit Deepgram selection.
- Display that the active backend is remote before microphone capture begins.
- Start capture only after the WebSocket is ready.
- Preserve current focus-aware delivery, audio meter, cleanup, and stale-generation protection.
- Delete temporary audio on every completion path.
- Run `npm run check` and `npm test` before completion.

### Ask first

- Adding a runtime dependency.
- Making Deepgram the default backend.
- Changing capture tools, keyboard bindings, or the Deepgram model.
- Sending interim transcripts to the editor.

### Never

- Send audio to Deepgram unless `PI_DICTATE_BACKEND=deepgram`.
- Fall back automatically from any backend to Deepgram.
- Log API keys, transcripts, audio content, or temporary audio paths.
- Insert partial text after a failure, timeout, cancellation, or shutdown.
- Call production Deepgram services from automated tests.

## Success Criteria

1. `readConfig()` accepts `deepgram` and reports a clear error when its API key is absent or its language is `auto`.
2. Audio reaches Deepgram while the user is speaking, not after the recording is complete.
3. The first PCM sample is captured only after the WebSocket opens.
4. Stop sends `CloseStream`, waits for final results, and inserts normalized text exactly once.
5. Error, timeout, cancel, and shutdown paths insert nothing and leave no recorder, socket, timer, or temporary file active.
6. Selecting `local` makes no network request; selecting `litellm` retains its existing behavior.
7. Existing tests plus new Deepgram tests pass with `npm test`, and `npm run check` passes.
8. A manual test with a real Deepgram key completes successfully and confirms live audio streaming.

## Open Questions

None. The assumptions above are the agreed scope for planning.
