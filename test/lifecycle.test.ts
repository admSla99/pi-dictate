import assert from "node:assert/strict";
import test from "node:test";
import dictate, { type AudioRecorder, type DictateDependencies } from "../index.ts";

function fakeRecorder(name = "recording.wav", discard = async () => {}) {
  let discarded = false;
  let discardCount = 0;
  let fail!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => (fail = resolve));
  const recorder: AudioRecorder = {
    path: `/tmp/${name}`,
    failure,
    async stop() {
      return { path: recorder.path, duration: 5 };
    },
    async discard() {
      if (discarded) return;
      discarded = true;
      discardCount++;
      await discard();
    },
  };
  return { recorder, fail, get discardCount() { return discardCount; } };
}

/**
 * Fake Deepgram session. `ready` is controlled manually so tests can assert
 * ordering around the connecting phase; `finish()` auto-resolves (or throws,
 * for `finishResult` errors) on the next microtask, like `fakeRecorder`'s
 * default quick `stop()`/`discard()`.
 */
function fakeDeepgramSession(finishResult: string | Error = "Ahoj svet.") {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const sentAudio: Buffer[] = [];
  let finishCalls = 0;
  let abortCalls = 0;
  const session = {
    ready,
    sendAudio(chunk: Buffer) {
      sentAudio.push(chunk);
    },
    async finish() {
      finishCalls++;
      if (finishResult instanceof Error) throw finishResult;
      return finishResult;
    },
    async abort() {
      abortCalls++;
    },
  };
  return {
    session,
    sentAudio,
    openReady: () => resolveReady(),
    failReady: (error: Error) => rejectReady(error),
    get finishCalls() { return finishCalls; },
    get abortCalls() { return abortCalls; },
  };
}

const deepgramEnv: NodeJS.ProcessEnv = {
  PI_DICTATE_BACKEND: "deepgram",
  DEEPGRAM_API_KEY: "dg_test_key",
  PI_DICTATE_LANGUAGE: "sk",
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function harness(dependencies: Partial<DictateDependencies>, env: NodeJS.ProcessEnv = {}) {
  const events = new Map<string, (...args: any[]) => any>();
  let shortcutRegistrations = 0;
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const editor = {
    text: "Existing",
    getText() { return this.text; },
    setText(text: string) { this.text = text; },
  };
  let inputListener: ((data: string) => unknown) | null = null;
  const tui: { focusedComponent: any; requestRender(): void } = {
    focusedComponent: editor,
    requestRender() {},
  };
  const ctx = {
    mode: "tui",
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: (message: string, level: string) => notifications.push({ message, level }),
      onTerminalInput(listener: (data: string) => unknown) {
        inputListener = listener;
        return () => { inputListener = null; };
      },
      getEditorText: () => editor.text,
      setEditorText: (text: string) => { editor.text = text; },
      setWidget: (_key: string, factory: (tui: any) => unknown) => factory(tui),
    },
  };
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler),
    registerShortcut: () => { shortcutRegistrations++; },
  };

  const previousEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    dictate(pi as any, dependencies);
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  await events.get("session_start")?.({}, ctx);
  return {
    ctx,
    editor,
    notifications,
    statuses,
    get shortcutRegistrations() { return shortcutRegistrations; },
    focus(component: any) { tui.focusedComponent = component; },
    async toggle() {
      inputListener?.("\u001bm");
      await new Promise((resolve) => setImmediate(resolve));
    },
    async cancel() {
      inputListener?.("\u001bn");
      await new Promise((resolve) => setImmediate(resolve));
    },
    shutdown: () => events.get("session_shutdown")?.(),
    sendInput: (data: string) => inputListener?.(data),
  };
}

test("terminal shortcuts use the public listener and ignore repeat and release events", async () => {
  const fake = fakeRecorder();
  let starts = 0;
  const app = await harness({ recordAudio: async () => { starts++; return fake.recorder; } });

  assert.equal(app.shortcutRegistrations, 0);
  assert.equal(app.sendInput("\u001b[109;3:2u"), undefined);
  assert.equal(app.sendInput("\u001b[109;3:3u"), undefined);
  assert.equal(starts, 0);
  assert.deepEqual(app.sendInput("\u001bm"), { consume: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  await app.cancel();
});

test("local lifecycle records, transcribes, inserts, and cleans up", async () => {
  const fake = fakeRecorder();
  let deepgramCalls = 0;
  const app = await harness({
    recordAudio: async (_config, options) => {
      options?.onLevel?.(0.5);
      return fake.recorder;
    },
    transcribeLocal: async () => "new words",
    createDeepgramSession: () => { deepgramCalls++; throw new Error("should not be called"); },
  });

  await app.toggle();
  assert.match(app.statuses.at(-1)!, /listening/);
  await app.toggle();

  assert.equal(app.editor.text, "Existing new words");
  assert.equal(fake.discardCount, 1);
  assert.equal(app.statuses.at(-1), undefined);
  assert.equal(deepgramCalls, 0);
});

test("delivery appends through an editor nested in a focused dialog", async () => {
  const fake = fakeRecorder();
  const dialogEditor = {
    text: "Dialog",
    getText() { return this.text; },
    setText(text: string) { this.text = text; },
  };
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async () => "new words",
  });
  app.focus({ editor: dialogEditor });

  await app.toggle();
  await app.toggle();

  assert.equal(dialogEditor.text, "Dialog new words");
  assert.equal(app.editor.text, "Existing");
});

test("delivery types into a focused input component", async () => {
  const fake = fakeRecorder();
  let typed = "";
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async () => "new words",
  });
  app.focus({ handleInput: (text: string) => { typed += text; } });

  await app.toggle();
  await app.toggle();

  assert.equal(typed, "new words");
  assert.equal(app.editor.text, "Existing");
});

test("delivery falls back to the main editor when focus is absent", async () => {
  const fake = fakeRecorder();
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async () => "new words",
  });
  app.focus(null);

  await app.toggle();
  await app.toggle();

  assert.equal(app.editor.text, "Existing new words");
  assert.deepEqual(app.notifications.at(-1), {
    message: "Dictation inserted into the main editor because no input field is focused",
    level: "warning",
  });
});

test("a local transcription error inserts nothing and never falls back remotely", async () => {
  const fake = fakeRecorder();
  let remoteCalls = 0;
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async () => { throw new Error("transcription failed"); },
    transcribeLiteLLM: async () => { remoteCalls++; return "remote fallback"; },
  });

  await app.toggle();
  await app.toggle();

  assert.equal(app.editor.text, "Existing");
  assert.equal(fake.discardCount, 1);
  assert.equal(remoteCalls, 0);
  assert.deepEqual(app.notifications.at(-1), { message: "transcription failed", level: "error" });
});

test("LiteLLM transcription is selected only by explicit configuration", async () => {
  const fake = fakeRecorder();
  let localCalls = 0;
  let remoteCalls = 0;
  let deepgramCalls = 0;
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async () => { localCalls++; return "local"; },
    transcribeLiteLLM: async () => { remoteCalls++; return "remote"; },
    createDeepgramSession: () => { deepgramCalls++; throw new Error("should not be called"); },
  }, {
    PI_DICTATE_BACKEND: "litellm",
    PI_DICTATE_LITELLM_URL: "https://llm.example/v1/audio/transcriptions",
  });

  await app.toggle();
  await app.toggle();

  assert.equal(app.editor.text, "Existing remote");
  assert.equal(localCalls, 0);
  assert.equal(remoteCalls, 1);
  assert.equal(deepgramCalls, 0);
});

test("cancel waits for the transcriber to terminate before deleting its WAV", async () => {
  const fake = fakeRecorder();
  let transcriptionStarted!: () => void;
  const started = new Promise<void>((resolve) => (transcriptionStarted = resolve));
  let terminate!: () => void;
  const terminated = new Promise<void>((resolve) => (terminate = resolve));
  let aborted = false;
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async (_path, _duration, _config, signal) => {
      transcriptionStarted();
      signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      await terminated;
      throw new DOMException("aborted", "AbortError");
    },
  });

  await app.toggle();
  const stopping = app.toggle();
  await started;
  const cancelling = app.cancel();
  await Promise.resolve();
  assert.equal(aborted, true);
  assert.equal(fake.discardCount, 0);
  terminate();
  await Promise.all([cancelling, stopping]);

  assert.equal(app.editor.text, "Existing");
  assert.equal(fake.discardCount, 1);
});

test("an unexpected recorder exit reports the error and cleans up", async () => {
  const fake = fakeRecorder();
  const app = await harness({ recordAudio: async () => fake.recorder });

  await app.toggle();
  fake.fail(new Error("arecord exited unexpectedly (code 1)"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.discardCount, 1);
  assert.deepEqual(app.notifications.at(-1), {
    message: "arecord exited unexpectedly (code 1)",
    level: "error",
  });
});

test("shutdown during recording discards the temporary recording", async () => {
  const fake = fakeRecorder();
  const app = await harness({ recordAudio: async () => fake.recorder });

  await app.toggle();
  await app.shutdown();

  assert.equal(fake.discardCount, 1);
  assert.equal(app.statuses.at(-1), undefined);
});

test("shutdown waits for an active transcriber to terminate", async () => {
  const fake = fakeRecorder();
  let started!: () => void;
  const transcriptionStarted = new Promise<void>((resolve) => (started = resolve));
  let terminate!: () => void;
  const terminated = new Promise<void>((resolve) => (terminate = resolve));
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async (_path, _duration, _config, signal) => {
      started();
      await terminated;
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      return "too late";
    },
  });

  await app.toggle();
  const stopping = app.toggle();
  await transcriptionStarted;
  const shutdown = app.shutdown();
  await Promise.resolve();
  assert.equal(fake.discardCount, 0);
  terminate();
  await Promise.all([shutdown, stopping]);

  assert.equal(fake.discardCount, 1);
  assert.equal(app.editor.text, "Existing");
});

test("shutdown disables input before waiting for recorder disposal", async () => {
  let finishDiscard!: () => void;
  const discarding = new Promise<void>((resolve) => (finishDiscard = resolve));
  const fake = fakeRecorder("recording.wav", () => discarding);
  let starts = 0;
  const app = await harness({
    recordAudio: async () => {
      starts++;
      return fake.recorder;
    },
  });

  await app.toggle();
  const shutdown = app.shutdown();
  app.sendInput("\u001bm");
  await Promise.resolve();
  assert.equal(starts, 1);
  finishDiscard();
  await shutdown;
});

test("delivery failure still cleans up the recording", async () => {
  const fake = fakeRecorder();
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async () => "new words",
  });
  app.editor.setText = () => { throw new Error("editor closed"); };

  await app.toggle();
  await app.toggle();

  assert.equal(fake.discardCount, 1);
  assert.deepEqual(app.notifications.at(-1), {
    message: "Could not insert dictation: editor closed",
    level: "error",
  });
});

test("recorder disposal failure is reported instead of being suppressed", async () => {
  const fake = fakeRecorder("recording.wav", async () => { throw new Error("remove failed"); });
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async () => "new words",
  });

  await app.toggle();
  await app.toggle();

  assert.equal(app.editor.text, "Existing");
  assert.deepEqual(app.notifications.at(-1), {
    message: "Could not clean up dictation: remove failed",
    level: "error",
  });
});

test("cleanup finishes before another recording can start", async (t) => {
  let finishDiscard!: () => void;
  const discarding = new Promise<void>((resolve) => (finishDiscard = resolve));
  let discardStarted!: () => void;
  const startedDiscard = new Promise<void>((resolve) => (discardStarted = resolve));
  const first = fakeRecorder("first.wav", async () => {
    discardStarted();
    await discarding;
  });
  const second = fakeRecorder("second.wav");
  let starts = 0;
  const app = await harness({
    recordAudio: async () => ++starts === 1 ? first.recorder : second.recorder,
    transcribeLocal: async (path) => path.includes("first") ? "first" : "second",
  });
  t.after(() => app.shutdown());

  await app.toggle();
  const firstStop = app.toggle();
  await startedDiscard;
  const earlyStart = app.toggle();
  finishDiscard();
  await Promise.all([firstStop, earlyStart]);

  assert.equal(starts, 1);
  assert.equal(app.editor.text, "Existing first");
  await app.toggle();
  await app.toggle();
  assert.equal(app.editor.text, "Existing first second");
});

test("cancel suppresses delivery while successful cleanup is still disposing", async () => {
  let finishDiscard!: () => void;
  const discarding = new Promise<void>((resolve) => (finishDiscard = resolve));
  let discardStarted!: () => void;
  const startedDiscard = new Promise<void>((resolve) => (discardStarted = resolve));
  const fake = fakeRecorder("recording.wav", async () => {
    discardStarted();
    await discarding;
  });
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async () => "must not be inserted",
  });

  await app.toggle();
  const stopping = app.toggle();
  await startedDiscard;
  const cancelling = app.cancel();
  finishDiscard();
  await Promise.all([stopping, cancelling]);

  assert.equal(app.editor.text, "Existing");
});

test("shutdown suppresses delivery while successful cleanup is still disposing", async () => {
  let finishDiscard!: () => void;
  const discarding = new Promise<void>((resolve) => (finishDiscard = resolve));
  let discardStarted!: () => void;
  const startedDiscard = new Promise<void>((resolve) => (discardStarted = resolve));
  const fake = fakeRecorder("recording.wav", async () => {
    discardStarted();
    await discarding;
  });
  const app = await harness({
    recordAudio: async () => fake.recorder,
    transcribeLocal: async () => "must not be inserted",
  });

  await app.toggle();
  const stopping = app.toggle();
  await startedDiscard;
  const shutdown = app.shutdown();
  finishDiscard();
  await Promise.all([stopping, shutdown]);

  assert.equal(app.editor.text, "Existing");
});

test("a stale recorder completion is discarded before the next session", async (t) => {
  const first = fakeRecorder("first.wav");
  const second = fakeRecorder("second.wav");
  let resolveFirst!: (recorder: AudioRecorder) => void;
  const firstStart = new Promise<AudioRecorder>((resolve) => (resolveFirst = resolve));
  let calls = 0;
  const app = await harness({
    recordAudio: async () => ++calls === 1 ? firstStart : second.recorder,
  });
  t.after(() => app.shutdown());

  const oldStart = app.toggle();
  const oldCancel = app.cancel();
  const earlyStart = app.toggle();
  resolveFirst(first.recorder);
  await Promise.all([oldStart, oldCancel, earlyStart]);

  assert.equal(calls, 1);
  assert.equal(first.discardCount, 1);
  await app.toggle();
  assert.equal(calls, 2);
});

test("a cancelled stale transcription cannot affect the next dictation", async (t) => {
  const first = fakeRecorder("first.wav");
  const second = fakeRecorder("second.wav");
  let resolveFirst!: (text: string) => void;
  const firstTranscription = new Promise<string>((resolve) => (resolveFirst = resolve));
  let recordings = 0;
  let transcriptions = 0;
  const app = await harness({
    recordAudio: async () => ++recordings === 1 ? first.recorder : second.recorder,
    transcribeLocal: async () => ++transcriptions === 1 ? firstTranscription : "fresh",
  });
  t.after(() => app.shutdown());

  await app.toggle();
  const oldStop = app.toggle();
  await Promise.resolve();
  const oldCancel = app.cancel();
  const earlyStart = app.toggle();
  resolveFirst("stale");
  await Promise.all([oldStop, oldCancel, earlyStart]);

  assert.equal(recordings, 1);
  assert.equal(app.editor.text, "Existing");
  await app.toggle();
  await app.toggle();
  assert.equal(app.editor.text, "Existing fresh");
});

test("Deepgram lifecycle connects before capturing, streams audio, finalizes, and delivers exactly once", async (t) => {
  const dg = fakeDeepgramSession("Ahoj svet.");
  const fake = fakeRecorder();
  let recordCalls = 0;
  let capturedOnAudio: ((chunk: Buffer) => void) | undefined;
  let localCalls = 0;
  const app = await harness(
    {
      createDeepgramSession: () => dg.session,
      recordAudio: async (_config, options) => {
        recordCalls++;
        capturedOnAudio = options?.onAudio;
        return fake.recorder;
      },
      transcribeLocal: async () => {
        localCalls++;
        return "should not be used";
      },
    },
    deepgramEnv,
  );
  t.after(() => app.shutdown());

  const starting = app.toggle();
  await tick();
  assert.equal(recordCalls, 0, "must not start capturing before the socket is ready");
  const connectingStatus = app.statuses.at(-1) ?? "";
  assert.match(connectingStatus, /connecting/i);
  assert.match(connectingStatus, /deepgram/i);

  dg.openReady();
  await starting;
  assert.equal(recordCalls, 1);

  capturedOnAudio?.(Buffer.from([9, 9]));
  assert.deepEqual(dg.sentAudio, [Buffer.from([9, 9])]);

  await app.toggle();

  assert.equal(dg.finishCalls, 1);
  assert.equal(app.editor.text, "Existing Ahoj svet.");
  assert.equal(fake.discardCount, 1);
  assert.equal(localCalls, 0);
  assert.equal(app.statuses.at(-1), undefined);
});

test("shutdown awaits an in-flight Deepgram abort before completing recorder disposal", async () => {
  const fake = fakeRecorder();
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));
  let resolveAbort!: () => void;
  const abortSettled = new Promise<void>((resolve) => (resolveAbort = resolve));
  let abortCalls = 0;
  const session = {
    ready,
    sendAudio() {},
    async finish() { return "unused"; },
    async abort() {
      abortCalls++;
      await abortSettled;
    },
  };
  const app = await harness(
    {
      createDeepgramSession: () => session,
      recordAudio: async () => fake.recorder,
    },
    deepgramEnv,
  );

  const starting = app.toggle();
  await tick();
  resolveReady();
  await starting;
  // Let the recorder's own startup microtask chain fully settle (its `await
  // pending` continuation assigns `recorder`) before shutting down, so this
  // test exercises the ordinary teardown path rather than the stale-generation
  // discard branch inside beginCapture.
  await tick();

  const shutdown = app.shutdown();
  await Promise.resolve();
  assert.equal(abortCalls, 1);
  assert.equal(fake.discardCount, 0, "cleanup must not dispose the recorder before Deepgram abort settles");

  resolveAbort();
  await shutdown;

  assert.equal(fake.discardCount, 1);
});
