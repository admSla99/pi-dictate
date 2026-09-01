import assert from "node:assert/strict";
import test from "node:test";
import { deepgramListenUrl, readConfig } from "../index.ts";

const configFor = (overrides: NodeJS.ProcessEnv = {}) =>
  readConfig({
    PI_DICTATE_BACKEND: "deepgram",
    DEEPGRAM_API_KEY: "dg_super_secret_key",
    PI_DICTATE_LANGUAGE: "sk",
    ...overrides,
  });

test("deepgramListenUrl targets the live-transcription endpoint", () => {
  const url = new URL(deepgramListenUrl(configFor()));
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, "wss://api.deepgram.com/v1/listen");
});

test("deepgramListenUrl sends exactly the reviewed streaming parameters", () => {
  const url = new URL(deepgramListenUrl(configFor()));
  assert.deepEqual(Object.fromEntries(url.searchParams.entries()), {
    model: "nova-3",
    language: "sk",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "false",
    smart_format: "true",
    punctuate: "true",
    endpointing: "300",
  });
});

test("deepgramListenUrl reflects the configured explicit language", () => {
  const url = new URL(deepgramListenUrl(configFor({ PI_DICTATE_LANGUAGE: "en" })));
  assert.equal(url.searchParams.get("language"), "en");
});

test("deepgramListenUrl never includes the API key", () => {
  const url = deepgramListenUrl(configFor());
  assert.doesNotMatch(url, /dg_super_secret_key/);
});
