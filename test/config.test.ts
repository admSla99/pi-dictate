import assert from "node:assert/strict";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { platformError, readConfig } from "../index.ts";

test("readConfig applies defaults", () => {
  assert.deepEqual(readConfig({}), {
    backend: "local",
    audioDevice: "default",
    language: "auto",
    threads: Math.min(availableParallelism(), 8),
    whisperBin: "whisper-cli",
    modelPath: join(homedir(), ".local", "share", "pi-dictate", "ggml-large-v3-turbo-q5_0.bin"),
    audioContext: undefined,
    litellmUrl: undefined,
    litellmApiKey: undefined,
    litellmModel: "whisper-1",
    debug: false,
  });
});

test("readConfig applies environment overrides", () => {
  assert.deepEqual(
    readConfig({
      PI_DICTATE_BACKEND: "litellm",
      PI_DICTATE_AUDIO_DEVICE: "hw:1,0",
      PI_DICTATE_LANGUAGE: "en",
      PI_DICTATE_THREADS: "4",
      PI_DICTATE_WHISPER_BIN: "/opt/whisper-cli",
      PI_DICTATE_MODEL_PATH: "/models/slovak.bin",
      PI_DICTATE_AUDIO_CONTEXT: "512",
      PI_DICTATE_LITELLM_URL: "https://llm.example/v1/audio/transcriptions",
      PI_DICTATE_LITELLM_API_KEY: "test-key",
      PI_DICTATE_LITELLM_MODEL: "whisper-large",
      DICTATE_DEBUG: "1",
    }),
    {
      backend: "litellm",
      audioDevice: "hw:1,0",
      language: "en",
      threads: 4,
      whisperBin: "/opt/whisper-cli",
      modelPath: "/models/slovak.bin",
      audioContext: 512,
      litellmUrl: "https://llm.example/v1/audio/transcriptions",
      litellmApiKey: "test-key",
      litellmModel: "whisper-large",
      debug: true,
    },
  );
});

test("readConfig rejects LiteLLM without a URL", () => {
  assert.throws(
    () => readConfig({ PI_DICTATE_BACKEND: "litellm" }),
    /PI_DICTATE_LITELLM_URL is required when PI_DICTATE_BACKEND=litellm/,
  );
});

test("platform guard explains that dictation is Linux-only", () => {
  assert.equal(platformError("linux"), null);
  assert.match(platformError("darwin")!, /Linux only.*darwin/);
});
