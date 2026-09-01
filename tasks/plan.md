# Implementation Plan: Linux-native local dictation

Source of truth: [`SPEC.md`](../SPEC.md) revision 4.
Task checklist: [`todo.md`](todo.md).

## Overview

Replace the Deepgram streaming backend and its macOS assumptions in `index.ts` with a Linux capture path (`arecord`), a local whisper.cpp backend using the converted Slovak model, and an opt-in LiteLLM remote backend. The TUI behaviour the user already relies on — `alt+m` toggle, `alt+n` cancel, level meter, focus-aware insertion — is preserved.

The prerequisite conversion is already done. `~/.local/bin/whisper-cli` and `~/.local/share/pi-dictate/ggml-kinit-sk-v2-q5_0.bin` exist and are verified, so no task here depends on unproven model work.

## Architecture Decisions

- **One implementation file.** `index.ts` keeps everything. Two functions, `transcribeLocal()` and `transcribeLiteLLM()`, replace what would otherwise be a backend abstraction with a single implementation each.
- **Record to disk, transcribe after stop.** Streaming is gone, so audio goes straight to a temp WAV. Nothing buffers the whole recording in memory, which is what makes the no-duration-cap decision safe.
- **Never pass `-nt`.** Measured: it silently truncates past 30 s with this fine-tune. Timestamps stay on and the extension strips the prefixes. This is encoded as a test, not a comment.
- **Scale `-ac` to recording length.** The Whisper encoder pads to 30 s regardless of speech length; without this a 5 s dictation costs 10.9 s instead of 4.8 s.
- **Fresh process per dictation.** Model load is 0.24 s, so no daemon.
- **Cut over atomically.** Both new backends are built and tested against fakes *before* Deepgram is removed, so the risky rewiring step is small and reversible.

## Dependency Graph

```
T1 test scaffolding
 │
 ├── T2 config + platform guard ─┐
 ├── T3 audio helpers ───────────┤
 └── T4 transcript helpers ──────┤
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
        T5 local backend                     T6 arecord recorder
        (spawn whisper-cli)                  (capture + WAV writer)
              │                                     │
              └──────────────────┬──────────────────┘
                                 │
                        T7 cutover: state machine,
                        remove Deepgram + SoX
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
        T8 LiteLLM backend                   T9 delivery + keybindings
              │                                     │
              └──────────────────┬──────────────────┘
                                 │
                    T10 README   T11 package metadata
                                 │
                        T12 repoint at fork
```

T2, T3, T4 are mutually independent. T5 and T6 are mutually independent. T8 and T9 are mutually independent.

## Task List

### Phase 1: Foundation

Pure logic and tests. Additive only — the extension keeps working on Deepgram throughout this phase.

- [x] Task 1: Test scaffolding and `npm test`
- [x] Task 2: Configuration and platform guard
- [x] Task 3: Audio helpers (WAV header, audio-context sizing)
- [x] Task 4: Transcript helpers (timestamp stripping, append normalization)

### Checkpoint: Foundation

- [x] `npm run check` and `npm test` pass
- [ ] Deepgram dictation still works, unchanged
- [x] Every helper the cutover needs exists and is covered

### Phase 2: Local dictation path

- [x] Task 5: Local whisper.cpp backend
- [x] Task 6: `arecord` recorder and WAV writer
- [x] Task 7: Cutover — new state machine, remove Deepgram and SoX

### Checkpoint: Local dictation

- [ ] `alt+m` records and inserts Slovak text with no network access
- [ ] A 50 s recording matches a timestamped reference run word for word
- [ ] A 5 s dictation completes in under 6 s
- [x] `alt+n` leaves nothing behind, in either non-idle state
- [x] Review with human before proceeding

### Phase 3: Remote backend and delivery

- [x] Task 8: LiteLLM remote backend
- [x] Task 9: Delivery targets and keybinding cleanup

### Checkpoint: Feature complete

- [x] `PI_DICTATE_BACKEND=litellm` works against a mock endpoint
- [x] A local failure never triggers a remote request
- [x] Insertion works in the main editor, popups, and the no-focus fallback
- [x] No `pbcopy`, no `registerShortcut`

### Phase 4: Documentation

- [x] Task 10: README rewrite
- [x] Task 11: Package metadata
- [x] Task 12: Repoint the project at the fork

### Checkpoint: Complete

- [ ] All 15 spec success criteria verified
- [x] `npm run check` and `npm test` pass offline
- [x] `origin` is `admSla99/pi-dictate`; upstream still fetchable
- [x] Ready for review

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Cutover in T7 breaks dictation in a way tests miss | High | T5 and T6 are proven against fakes first; T7 is then a wiring change. Manual smoke test is a checkpoint gate. |
| `tui.focusedComponent` disappears in a future pi release | Medium | Accepted per spec. `resolveTarget()` returns `null` and delivery degrades to the main editor rather than throwing. Covered by a test. |
| `-ac` margin too tight, tail of a recording lost | Medium | 150-frame (3 s) margin, clamped to 1500. `PI_DICTATE_AUDIO_CONTEXT` overrides. T3 tests the boundary arithmetic. |
| `arecord` default device wrong on another machine | Medium | `PI_DICTATE_AUDIO_DEVICE`. Spawn failure produces an actionable error naming `alsa-utils`. |
| A future contributor reintroduces `-nt` | Medium | Test asserts the argument list never contains it; spec Boundaries forbid it. |
| Long recording fills `/tmp` | Low | Streamed to disk at ~1.9 MB/min; temp file deleted on every exit path including cancel and shutdown. |
| Regression in stale-callback handling during the rewrite | Medium | The existing `generation` guard is preserved and gets an explicit test in T7. |
| A push lands on upstream instead of the fork | Medium | `origin` still points at `amosblomqvist/pi-dictate` with `main` 12 commits ahead. T12 repoints it and verifies with `git push --dry-run` before any real push. |

## Parallelization

- Safe to parallelize: T2, T3, T4 after T1; T5 and T6 after Phase 1; T8 and T9 after T7.
- Must be sequential: T1 before everything; T7 after both T5 and T6; T10 after T9 so the README documents final behaviour; T12 after T10 and T11, since all three edit `README.md` and `package.json`.

## Definition of Done (applies to every task)

- `npm run check` passes.
- `npm test` passes.
- No secrets, transcripts, or audio paths in logs.
- No new runtime npm dependency.
- Changes stay inside the task's stated scope.
