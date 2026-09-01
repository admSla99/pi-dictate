/**
 * Linux-native voice dictation for pi.
 *
 * Press alt+m to start or stop, and alt+n to cancel. Audio is recorded to a
 * private temporary WAV, transcribed locally, then inserted at the current
 * text target.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, openAsBlob } from "node:fs";
import { access, chmod, mkdtemp, open, rm } from "node:fs/promises";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

type Backend = "local" | "litellm";

export interface DictateConfig {
  backend: Backend;
  audioDevice: string;
  language: string;
  threads: number;
  whisperBin: string;
  modelPath: string;
  audioContext?: number;
  litellmUrl?: string;
  litellmApiKey?: string;
  litellmModel: string;
  debug: boolean;
}

const positiveInteger = (name: string, value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

/** Read extension configuration from the environment once per extension load. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): DictateConfig {
  const {
    PI_DICTATE_BACKEND,
    PI_DICTATE_AUDIO_DEVICE,
    PI_DICTATE_LANGUAGE,
    PI_DICTATE_THREADS,
    PI_DICTATE_WHISPER_BIN,
    PI_DICTATE_MODEL_PATH,
    PI_DICTATE_AUDIO_CONTEXT,
    PI_DICTATE_LITELLM_URL,
    PI_DICTATE_LITELLM_API_KEY,
    PI_DICTATE_LITELLM_MODEL,
    DICTATE_DEBUG,
  } = env;

  const backend = PI_DICTATE_BACKEND ?? "local";
  if (backend !== "local" && backend !== "litellm") {
    throw new Error("PI_DICTATE_BACKEND must be 'local' or 'litellm'");
  }
  if (backend === "litellm" && !PI_DICTATE_LITELLM_URL) {
    throw new Error("PI_DICTATE_LITELLM_URL is required when PI_DICTATE_BACKEND=litellm");
  }

  return {
    backend,
    audioDevice: PI_DICTATE_AUDIO_DEVICE ?? "default",
    language: PI_DICTATE_LANGUAGE ?? "sk",
    threads: positiveInteger("PI_DICTATE_THREADS", PI_DICTATE_THREADS, Math.min(availableParallelism(), 8)),
    whisperBin: PI_DICTATE_WHISPER_BIN ?? "whisper-cli",
    modelPath:
      PI_DICTATE_MODEL_PATH ?? join(homedir(), ".local", "share", "pi-dictate", "ggml-kinit-sk-v2-q5_0.bin"),
    audioContext:
      PI_DICTATE_AUDIO_CONTEXT === undefined
        ? undefined
        : positiveInteger("PI_DICTATE_AUDIO_CONTEXT", PI_DICTATE_AUDIO_CONTEXT, 1),
    litellmUrl: PI_DICTATE_LITELLM_URL,
    litellmApiKey: PI_DICTATE_LITELLM_API_KEY,
    litellmModel: PI_DICTATE_LITELLM_MODEL ?? "whisper-1",
    debug: !!DICTATE_DEBUG,
  };
}

export function platformError(platform: NodeJS.Platform = process.platform): string | null {
  return platform === "linux" ? null : `pi-dictate supports Linux only; current platform is ${platform}`;
}

/** Build a 44-byte WAV header for finished 16 kHz mono S16_LE PCM. */
export function wavHeader(pcmBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

/** Size whisper.cpp's audio context to the recording unless explicitly overridden. */
export function audioContext(seconds: number, override?: number): number {
  return override ?? Math.max(256, Math.min(1500, Math.ceil((seconds / 30) * 1500) + 150));
}

/** Strip whisper.cpp timestamps and normalize its output to one line. */
export function parseTranscript(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.replace(/^\[[\d:.]+ --> [\d:.]+\]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Run whisper.cpp for a completed WAV recording. */
export async function transcribeLocal(
  wavPath: string,
  seconds: number,
  config: DictateConfig,
  signal?: AbortSignal,
): Promise<string> {
  try {
    await access(config.modelPath);
  } catch {
    throw new Error(`Whisper model not found; run scripts/convert-model.sh`);
  }

  const args = [
    "-m",
    config.modelPath,
    "-f",
    wavPath,
    "-l",
    config.language,
    "-np",
    "-t",
    String(config.threads),
    "-ac",
    String(audioContext(seconds, config.audioContext)),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(config.whisperBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      killSignal: "SIGTERM",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    let processError: NodeJS.ErrnoException | undefined;
    child.on("error", (error: NodeJS.ErrnoException) => (processError = error));
    child.on("close", (code) => {
      if (processError) {
        reject(
          processError.code === "ENOENT"
            ? new Error(`whisper-cli not found; run scripts/convert-model.sh`)
            : processError,
        );
      } else if (code === 0) resolve(parseTranscript(stdout));
      else reject(new Error(`whisper-cli exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

/** Post a completed WAV recording to an OpenAI-compatible transcription endpoint. */
export async function transcribeLiteLLM(
  wavPath: string,
  config: DictateConfig,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = new URL(config.litellmUrl!);
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname);
  if (endpoint.protocol === "http:" && !loopback) {
    throw new Error("LiteLLM refuses plaintext HTTP to a non-loopback host");
  }

  const form = new FormData();
  form.append("file", await openAsBlob(wavPath, { type: "audio/wav" }), "recording.wav");
  form.append("model", config.litellmModel);
  form.append("language", config.language);
  form.append("response_format", "json");
  const headers = config.litellmApiKey
    ? { Authorization: `Bearer ${config.litellmApiKey}` }
    : undefined;
  const response = await fetch(endpoint, { method: "POST", headers, body: form, signal });
  if (!response.ok) {
    throw new Error(`LiteLLM returned ${response.status}: ${(await response.text()).trim().slice(0, 500)}`);
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || typeof (result as { text?: unknown }).text !== "string") {
    throw new Error("LiteLLM returned invalid JSON: expected a text field");
  }
  return (result as { text: string }).text;
}

export interface Recording {
  path: string;
  duration: number;
}

export interface AudioRecorder {
  path: string;
  failure: Promise<Error | null>;
  stop(): Promise<Recording>;
  discard(): Promise<void>;
}

/** Capture 16 kHz mono PCM with arecord into a private temporary WAV file. */
export async function recordAudio(
  config: DictateConfig,
  onLevel?: (rms: number) => void,
  arecordBin = "arecord",
): Promise<AudioRecorder> {
  const directory = await mkdtemp(join(tmpdir(), "pi-dictate-"));
  await chmod(directory, 0o700);
  const path = join(directory, "recording.wav");
  const output = createWriteStream(path, { mode: 0o600 });
  output.write(wavHeader(0));
  let pcmBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pcmBytes += chunk.length;
      onLevel?.(rmsFromPcm16(chunk));
      callback(null, chunk);
    },
  });
  const args = [
    "-q",
    ...(config.audioDevice === "default" ? [] : ["-D", config.audioDevice]),
    "-f",
    "S16_LE",
    "-r",
    "16000",
    "-c",
    "1",
    "-t",
    "raw",
    "-",
  ];
  const child = spawn(arecordBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const writing = pipeline(child.stdout, meter, output);
  void writing.catch(() => {});
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let stopping = false;
  let reportFailure!: (error: Error | null) => void;
  const failure = new Promise<Error | null>((resolve) => (reportFailure = resolve));
  void closed.then((exit) => {
    reportFailure(stopping ? null : new Error(`arecord exited unexpectedly (code ${exit.code})`));
  });
  void writing.catch((error) => {
    if (!stopping) reportFailure(error instanceof Error ? error : new Error(String(error)));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    child.stdout.destroy();
    await writing.catch(() => {});
    await rm(directory, { recursive: true, force: true });
    const message = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "arecord not found; install alsa-utils"
      : `Failed to start arecord: ${(error as Error).message}`;
    throw new Error(message);
  }

  let stopPromise: Promise<Recording> | undefined;
  let discardPromise: Promise<void> | undefined;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      const signalled = child.kill("SIGTERM");
      const [exit] = await Promise.all([closed, writing]);
      if (!signalled) throw new Error(`arecord exited unexpectedly (code ${exit.code})`);
      const file = await open(path, "r+");
      try {
        await file.write(wavHeader(pcmBytes), 0, 44, 0);
      } finally {
        await file.close();
      }
      return { path, duration: pcmBytes / 32_000 };
    })().catch(async (error) => {
      await rm(directory, { recursive: true, force: true });
      throw error;
    });
    return stopPromise;
  };

  return {
    path,
    failure,
    stop,
    discard() {
      if (discardPromise) return discardPromise;
      stopping = true;
      discardPromise = (async () => {
        if (stopPromise) await stopPromise.catch(() => {});
        else {
          child.kill("SIGTERM");
          await Promise.allSettled([closed, writing]);
        }
        await rm(directory, { recursive: true, force: true });
      })();
      return discardPromise;
    },
  };
}

/** Append normalized transcript text without changing existing target text. */
export function appendText(current: string, addition: string): string {
  const text = addition.replace(/\s+/g, " ").trim();
  if (!text) return current;
  return current + (current && !/\s$/.test(current) ? " " : "") + text;
}

type State = "idle" | "recording" | "transcribing";

// ── Focus-aware delivery ──────────────────────────────────────────────────
// The public terminal-input listener catches shortcuts even when a dialog has
// focus. A zero-height widget captures the TUI handle solely to inspect its
// private focusedComponent property when choosing where to insert text. If pi
// changes that property, delivery falls back to the public main-editor API.
interface EditorLike {
  getText(): string;
  setText(text: string): void;
}
type Target =
  | { kind: "editor"; editor: EditorLike }
  | { kind: "typable"; component: { handleInput(data: string): void } };

const asEditorLike = (value: any): EditorLike | null =>
  value && typeof value.getText === "function" && typeof value.setText === "function" ? value : null;

// Same braille frames pi-tui's Loader uses.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Audio meter — a tiny rolling waveform rendered in the status row while recording.
// Tweakable knobs:
//   METER_CELLS       = how many bars wide
//   METER_TICK_MS     = how often bars shift left (smaller = snappier, more renders)
//   METER_FLOOR_DB    = level at which the bar is empty (more negative = more sensitive)
//   METER_CEILING_DB  = level at which the bar is full (less negative = needs louder to peg)
const METER_CELLS = 6;
const METER_TICK_MS = 60;
const PEAK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
// const PEAK_BLOCKS = ["⠀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;

/** Compute normalized RMS (0..1) over a buffer of signed 16-bit little-endian PCM samples. */
export function rmsFromPcm16(buf: Buffer): number {
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount * 2; i += 2) {
    const s = buf.readInt16LE(i);
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / sampleCount) / 32768;
}

/** Map a normalized RMS value to one of PEAK_BLOCKS by converting to dB and clamping into the visible range. */
function rmsToBlock(rms: number): string {
  if (rms <= 0) return PEAK_BLOCKS[0]!;
  const db = 20 * Math.log10(rms);
  const t = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
  const idx = Math.floor(t * (PEAK_BLOCKS.length - 1));
  return PEAK_BLOCKS[idx]!;
}

export interface DictateDependencies {
  recordAudio: typeof recordAudio;
  transcribeLocal: typeof transcribeLocal;
  transcribeLiteLLM: typeof transcribeLiteLLM;
}

export default function (pi: ExtensionAPI, dependencies: Partial<DictateDependencies> = {}) {
  const startRecorder = dependencies.recordAudio ?? recordAudio;
  const transcribeLocally = dependencies.transcribeLocal ?? transcribeLocal;
  const transcribeRemotely = dependencies.transcribeLiteLLM ?? transcribeLiteLLM;
  let config: DictateConfig | null = null;
  let configError: string | null = null;
  try {
    config = readConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  const dbg = (msg: string) => {
    if (!config?.debug) return;
    try {
      appendFileSync("/tmp/dictate-debug.log", `${new Date().toISOString()} ${msg}\n`);
    } catch {}
  };

  let state: State = "idle";
  let recorderPromise: Promise<AudioRecorder> | null = null;
  let recorder: AudioRecorder | null = null;
  let transcriptionAbort: AbortController | null = null;
  let transcriptionPromise: Promise<string> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let insertAfterCleanup = false;
  let transcript = "";
  let activeCtx: ExtensionContext | null = null;
  let generation = 0;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerFrame = 0;
  let meterTimer: NodeJS.Timeout | null = null;
  let meter: number[] = new Array(METER_CELLS).fill(0);
  let currentLevel = 0;
  let tuiHandle: any = null;
  let removeInputListener: (() => void) | null = null;
  let lastCtx: ExtensionContext | null = null;
  let shuttingDown = false;

  const notify = (ctx: ExtensionContext | null, message: string, level: "error" | "warning") => {
    try {
      ctx?.ui.notify(message, level);
    } catch {}
  };
  const setStatus = (msg: string | undefined) => activeCtx?.ui.setStatus("dictate", msg);
  const stopSpinner = () => {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = null;
  };
  const stopMeter = () => {
    if (meterTimer) clearInterval(meterTimer);
    meterTimer = null;
  };
  const startMeter = () => {
    stopMeter();
    meter = new Array(METER_CELLS).fill(0);
    currentLevel = 0;
    const render = () => {
      const dot = activeCtx?.ui.theme.fg("error", "●") ?? "●";
      setStatus(`${dot} ${meter.map(rmsToBlock).join("")} listening…`);
    };
    render();
    meterTimer = setInterval(() => {
      meter.shift();
      meter.push(currentLevel);
      render();
    }, METER_TICK_MS);
  };
  const startSpinner = (suffix: string) => {
    stopSpinner();
    spinnerFrame = 0;
    setStatus(`${SPINNER_FRAMES[0]} ${suffix}`);
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      setStatus(`${SPINNER_FRAMES[spinnerFrame]} ${suffix}`);
    }, SPINNER_INTERVAL_MS);
  };

  const resolveTarget = (): Target | null => {
    const focused = tuiHandle?.focusedComponent;
    if (!focused) return null;
    const editor = asEditorLike(focused) ?? asEditorLike(focused.editor);
    if (editor) return { kind: "editor", editor };
    if (typeof focused.handleInput === "function") return { kind: "typable", component: focused };
    return null;
  };

  const deliver = (ctx: ExtensionContext, text: string) => {
    if (!text) return;
    const target = resolveTarget();
    if (target?.kind === "editor") {
      target.editor.setText(appendText(target.editor.getText() ?? "", text));
      tuiHandle.requestRender?.();
      return;
    }
    if (target?.kind === "typable") {
      target.component.handleInput(text);
      tuiHandle.requestRender?.();
      return;
    }
    ctx.ui.setEditorText(appendText(ctx.ui.getEditorText() ?? "", text));
    ctx.ui.notify("Dictation inserted into the main editor because no input field is focused", "warning");
  };

  const cleanup = (insert: boolean, expectedGeneration = generation): Promise<void> => {
    if (cleanupPromise) {
      if (!insert) insertAfterCleanup = false;
      return cleanupPromise;
    }
    if (expectedGeneration !== generation) return Promise.resolve();
    insertAfterCleanup = insert;
    const pendingRecorder = recorderPromise;
    const currentRecorder = recorder;
    const pendingTranscription = transcriptionPromise;
    const ctx = activeCtx;
    const text = transcript;
    const abort = transcriptionAbort;

    generation++;
    state = "transcribing";
    recorderPromise = null;
    recorder = null;
    transcriptionAbort = null;
    transcriptionPromise = null;
    transcript = "";
    activeCtx = null;
    stopSpinner();
    stopMeter();
    try {
      ctx?.ui.setStatus("dictate", undefined);
    } catch {}
    abort?.abort();

    const work = (async () => {
      await pendingTranscription?.catch(() => {});
      const staleRecorder = currentRecorder ?? (await pendingRecorder?.catch(() => null));
      try {
        await staleRecorder?.discard();
      } catch (error) {
        notify(ctx, `Could not clean up dictation: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (insertAfterCleanup && ctx) {
        try {
          deliver(ctx, text);
        } catch (error) {
          notify(ctx, `Could not insert dictation: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
    })();
    cleanupPromise = work;
    void work.then(() => {
      if (cleanupPromise === work) {
        cleanupPromise = null;
        insertAfterCleanup = false;
        state = "idle";
      }
    });
    return work;
  };

  const startDictation = async (ctx: ExtensionContext) => {
    const unsupportedPlatform = platformError();
    if (unsupportedPlatform) {
      ctx.ui.notify(unsupportedPlatform, "error");
      return;
    }
    if (configError) {
      ctx.ui.notify(configError, "error");
      return;
    }

    activeCtx = ctx;
    transcript = "";
    state = "recording";
    const myGeneration = ++generation;
    dbg(`start (gen ${myGeneration})`);
    startMeter();
    const pending = startRecorder(
      config!,
      (level) => {
        if (myGeneration === generation) currentLevel = level;
      },
    );
    recorderPromise = pending;
    try {
      const startedRecorder = await pending;
      if (myGeneration !== generation) {
        await startedRecorder.discard();
        return;
      }
      recorder = startedRecorder;
      void startedRecorder.failure.then(async (error) => {
        if (!error || myGeneration !== generation) return;
        notify(activeCtx, error.message, "error");
        await cleanup(false, myGeneration);
      }).catch(() => {});
    } catch (error) {
      if (myGeneration !== generation) return;
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
      await cleanup(false, myGeneration);
    }
  };

  const stopDictation = async () => {
    if (state !== "recording" || !recorderPromise || !config) return;
    state = "transcribing";
    stopMeter();
    startSpinner("transcribing…");
    const myGeneration = generation;
    try {
      const currentRecorder = recorder ?? (await recorderPromise);
      if (myGeneration !== generation) return;
      recorder = currentRecorder;
      const recording = await currentRecorder.stop();
      if (myGeneration !== generation) return;
      const abort = new AbortController();
      transcriptionAbort = abort;
      const pendingTranscription = config.backend === "local"
        ? transcribeLocally(recording.path, recording.duration, config, abort.signal)
        : transcribeRemotely(recording.path, config, abort.signal);
      transcriptionPromise = pendingTranscription;
      const result = await pendingTranscription;
      if (myGeneration !== generation) return;
      transcript = result;
      await cleanup(true, myGeneration);
    } catch (error) {
      if (myGeneration !== generation) return;
      notify(activeCtx, error instanceof Error ? error.message : String(error), "error");
      await cleanup(false, myGeneration);
    }
  };

  const cancelDictation = async () => {
    if (state === "recording" || state === "transcribing") await cleanup(false);
  };

  const toggleDictation = async (ctx: ExtensionContext) => {
    if (shuttingDown) return;
    lastCtx = ctx;
    if (state === "idle") {
      await startDictation(ctx);
    } else if (state === "recording") {
      await stopDictation();
    }
  };

  const onGlobalInput = (data: string) => {
    if (shuttingDown || isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    if (matchesKey(data, Key.alt("m"))) {
      dbg(`alt+m state=${state}`);
      if (lastCtx) void toggleDictation(lastCtx);
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("n"))) {
      dbg(`alt+n state=${state}`);
      void cancelDictation();
      return { consume: true };
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    if (ctx.mode !== "tui") return;
    removeInputListener?.();
    removeInputListener = ctx.ui.onTerminalInput(onGlobalInput);
    ctx.ui.setWidget("dictate-tui-handle", (tui: any) => {
      tuiHandle = tui;
      return { render: () => [], invalidate: () => {} };
    });
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    removeInputListener?.();
    removeInputListener = null;
    if (state !== "idle") await cleanup(false);
    else await cleanupPromise;
  });
}
