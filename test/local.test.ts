import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig, transcribeLocal } from "../index.ts";

const fakeWhisper = join(import.meta.dirname, "fixtures", "fake-whisper-cli.sh");

async function setup(mode = "success") {
  const dir = await mkdtemp(join(tmpdir(), "pi-dictate-local-test-"));
  const modelPath = join(dir, "model.bin");
  const wavPath = join(dir, "recording.wav");
  await Promise.all([chmod(fakeWhisper, 0o755), writeFile(modelPath, mode), writeFile(wavPath, "wav")]);
  const config = readConfig({
    PI_DICTATE_WHISPER_BIN: fakeWhisper,
    PI_DICTATE_MODEL_PATH: modelPath,
    PI_DICTATE_LANGUAGE: "sk",
    PI_DICTATE_THREADS: "4",
  });
  return { dir, modelPath, wavPath, config };
}

test("transcribeLocal returns parsed output and passes safe whisper.cpp arguments", async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));

  assert.equal(await transcribeLocal(fixture.wavPath, 5, fixture.config), "Ahoj svet.");
  const args = (await readFile(`${fixture.modelPath}.args`, "utf8")).trim().split("\n");
  assert.deepEqual(args, [
    "-m",
    fixture.modelPath,
    "-f",
    fixture.wavPath,
    "-l",
    "sk",
    "-np",
    "-t",
    "4",
    "-ac",
    "400",
  ]);
  assert.ok(!args.includes("-nt"));
});

test("transcribeLocal reports a truncated non-zero-exit error", async (t) => {
  const fixture = await setup("fail");
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));

  await assert.rejects(transcribeLocal(fixture.wavPath, 5, fixture.config), (error: Error) => {
    assert.match(error.message, /exited with code 7: fake whisper failure/);
    assert.ok(error.message.length < 600);
    return true;
  });
});

test("transcribeLocal explains how to install a missing binary", async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));
  fixture.config.whisperBin = join(fixture.dir, "missing-whisper-cli");

  await assert.rejects(transcribeLocal(fixture.wavPath, 5, fixture.config), /scripts\/convert-model\.sh/);
});

test("transcribeLocal explains how to create a missing model", async (t) => {
  const fixture = await setup();
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));
  fixture.config.modelPath = join(fixture.dir, "missing-model.bin");

  await assert.rejects(transcribeLocal(fixture.wavPath, 5, fixture.config), /scripts\/convert-model\.sh/);
});

test("transcribeLocal aborts whisper-cli with SIGTERM", async (t) => {
  const fixture = await setup("abort");
  t.after(() => rm(fixture.dir, { recursive: true, force: true }));
  const controller = new AbortController();

  const transcription = transcribeLocal(fixture.wavPath, 5, fixture.config, controller.signal);
  setTimeout(() => controller.abort(), 100);

  await assert.rejects(transcription, { name: "AbortError" });
  assert.equal(await readFile(`${fixture.modelPath}.signal`, "utf8"), "TERM");
});
