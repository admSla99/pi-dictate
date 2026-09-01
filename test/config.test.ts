import assert from "node:assert/strict";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { platformError, readConfig } from "../index.ts";

const deepgramEnv = { PI_DICTATE_BACKEND: "deepgram", DEEPGRAM_API_KEY: "dg_test_key", PI_DICTATE_LANGUAGE: "sk" };

test("readConfig applies defaults", () => {
  assert.deepEqual(readConfig({}), {
    backend: "local",
    audioDevice: "default",
    language: "auto",
    threads: Math.min(availableParallelism(), 8),
    whisperBin: "whisper-cli",
    modelPath: join(homedir(), ".local", "share", "pi-dictate", "ggml-openai-large-v3-turbo-q5_0.bin"),
    audioContext: undefined,
    litellmUrl: undefined,
    litellmApiKey: undefined,
    litellmModel: "whisper-1",
    deepgramApiKey: undefined,
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
      PI_DICTATE_MODEL_PATH: "/models/custom.bin",
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
      modelPath: "/models/custom.bin",
      audioContext: 512,
      litellmUrl: "https://llm.example/v1/audio/transcriptions",
      litellmApiKey: "test-key",
      litellmModel: "whisper-large",
      deepgramApiKey: undefined,
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

test("readConfig accepts the deepgram backend with an explicit language", () => {
  assert.deepEqual(readConfig(deepgramEnv), {
    backend: "deepgram",
    audioDevice: "default",
    language: "sk",
    threads: Math.min(availableParallelism(), 8),
    whisperBin: "whisper-cli",
    modelPath: join(homedir(), ".local", "share", "pi-dictate", "ggml-openai-large-v3-turbo-q5_0.bin"),
    audioContext: undefined,
    litellmUrl: undefined,
    litellmApiKey: undefined,
    litellmModel: "whisper-1",
    deepgramApiKey: "dg_test_key",
    debug: false,
  });
});

test("readConfig rejects an unknown backend", () => {
  assert.throws(() => readConfig({ PI_DICTATE_BACKEND: "bogus" }), /PI_DICTATE_BACKEND must be/);
});

test("readConfig rejects deepgram without an API key", () => {
  assert.throws(
    () => readConfig({ PI_DICTATE_BACKEND: "deepgram", PI_DICTATE_LANGUAGE: "sk" }),
    /DEEPGRAM_API_KEY is required when PI_DICTATE_BACKEND=deepgram/,
  );
});

test("readConfig rejects deepgram with the default auto language", () => {
  assert.throws(
    () => readConfig({ PI_DICTATE_BACKEND: "deepgram", DEEPGRAM_API_KEY: "dg_test_key" }),
    /PI_DICTATE_LANGUAGE.*deepgram.*'auto'/s,
  );
});

test("readConfig rejects deepgram with an explicit auto language", () => {
  assert.throws(
    () =>
      readConfig({
        PI_DICTATE_BACKEND: "deepgram",
        DEEPGRAM_API_KEY: "dg_test_key",
        PI_DICTATE_LANGUAGE: "auto",
      }),
    /PI_DICTATE_LANGUAGE.*deepgram.*'auto'/s,
  );
});

test("readConfig never echoes the deepgram API key in its error messages", () => {
  assert.throws(() => readConfig({ PI_DICTATE_BACKEND: "deepgram" }), (error: Error) => {
    assert.doesNotMatch(error.message, /dg_test_key/);
    return true;
  });
});

test("readConfig never echoes a supplied deepgram API key when a different validation fails", () => {
  assert.throws(
    () => readConfig({ PI_DICTATE_BACKEND: "deepgram", DEEPGRAM_API_KEY: "dg_test_key" }),
    (error: Error) => {
      assert.match(error.message, /'auto'/);
      assert.doesNotMatch(error.message, /dg_test_key/);
      return true;
    },
  );
});

test("platform guard explains that dictation is Linux-only", () => {
  assert.equal(platformError("linux"), null);
  assert.match(platformError("darwin")!, /Linux only.*darwin/);
});
